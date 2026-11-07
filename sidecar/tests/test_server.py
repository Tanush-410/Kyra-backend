"""Integration tests against the real models. They need the downloaded models and two photos:

  KYRA_TEST_IMAGES=/path/to/dir  containing fullbody.jpg (one person, head to toe) and
                                 portrait.png (a different person, cropped above the knees)
"""

import base64
import os
from pathlib import Path

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from kyra_sidecar.config import Config

MODELS = Path(__file__).resolve().parent.parent / "models"
IMAGES = Path(os.environ.get("KYRA_TEST_IMAGES", "/nonexistent"))

pytestmark = pytest.mark.skipif(
    not (MODELS / "pose_landmarker_full.task").exists() or not (IMAGES / "fullbody.jpg").exists(),
    reason="needs downloaded models and KYRA_TEST_IMAGES",
)


def data_url(path: Path) -> str:
    return "data:image/jpeg;base64," + base64.b64encode(path.read_bytes()).decode()


def decode(url: str, flags=cv2.IMREAD_UNCHANGED) -> np.ndarray:
    return cv2.imdecode(np.frombuffer(base64.b64decode(url.split(",", 1)[1]), np.uint8), flags)


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    from kyra_sidecar.server import create_app

    os.environ["CAMERA"] = "off"
    config = Config()
    config.camera_enabled = False
    config.calibration_path = tmp_path_factory.mktemp("cal") / "calibration.json"
    with TestClient(create_app(config), base_url="http://127.0.0.1:8765", headers={"x-kyra-client": "tests"}) as test_client:
        yield test_client


def test_health_reports_disabled_camera(client):
    body = client.get("/health").json()
    assert body["camera"] == "disabled"
    assert client.get("/state").status_code == 409


def test_analyze_full_body_photo(client):
    bundle = client.post("/analyze", json={"imageDataUrl": data_url(IMAGES / "fullbody.jpg")}).json()
    assert bundle["checks"]["personCount"] == 1
    assert bundle["checks"]["fullBody"] is True
    assert bundle["checks"]["faceVisible"] is True
    assert bundle["checks"]["standing"] is False  # the sample photo shows someone seated
    assert bundle["guidance"]["state"] == "not_standing"
    skin = bundle["profile"]["skin"]
    assert skin["method"] == "undertone-detector" and skin["skinUndertone"] in ("warm", "cool", "neutral")
    assert skin["lab"]["L"] > 0 and "warmCool" in skin and isinstance(skin["requireConfirmation"], bool)
    assert len(bundle["faceEmbedding"]) == 128

    render = bundle["render"]
    image = decode(render["imageDataUrl"], cv2.IMREAD_COLOR)
    edit = decode(render["editMaskDataUrl"])
    keep = decode(render["keepMaskDataUrl"], cv2.IMREAD_GRAYSCALE)
    assert image.shape == (1536, 1024, 3)
    assert edit.shape == (1536, 1024, 4)
    editable = edit[..., 3] == 0
    assert 0.1 < editable.mean() < 0.9, "editable area should be the body, not everything or nothing"
    assert (keep > 0).mean() > 0.005, "head should be kept"
    assert not (editable & (keep > 200)).any(), "the kept head must never be editable"
    corners = image[[0, 0, -1, -1], [0, -1, 0, -1]]
    assert corners.max() < 10, "background should be cut out to black"


def test_analyze_cropped_portrait_asks_to_step_back(client):
    bundle = client.post("/analyze", json={"imageDataUrl": data_url(IMAGES / "portrait.png")}).json()
    assert bundle["checks"]["fullBody"] is False
    assert bundle["guidance"]["state"] == "too_close"


def test_analyze_rejects_garbage(client):
    assert client.post("/analyze", json={"imageDataUrl": "data:image/png;base64,AAAA"}).status_code == 400


def test_face_compare_same_and_different(client):
    full = data_url(IMAGES / "fullbody.jpg")
    same = client.post("/face/compare", json={"referenceDataUrl": full, "imageDataUrl": full}).json()
    assert same["samePerson"] is True and same["similarity"] > 0.9 and same["shift"] < 0.001

    other = client.post("/face/compare", json={"referenceDataUrl": full, "imageDataUrl": data_url(IMAGES / "portrait.png")}).json()
    assert other["faceFound"] is True and other["samePerson"] is False


def test_segment_returns_person_mask(client):
    body = client.post("/segment", json={"imageDataUrl": data_url(IMAGES / "portrait.png")}).json()
    mask = decode(body["maskDataUrl"], cv2.IMREAD_GRAYSCALE)
    assert body["personFound"] is True
    assert 0.2 < (mask > 127).mean() < 0.9


def test_height_calibration_rejects_seated_reference(client):
    response = client.post("/calibrate/height", json={"heightCm": 170, "imageDataUrl": data_url(IMAGES / "fullbody.jpg")})
    assert response.status_code == 422


def test_white_balance_calibration_from_grey_card(client):
    # A mid-grey card photographed under warm light: red high, blue low.
    card = np.zeros((400, 400, 3), np.uint8)
    card[100:300, 100:300] = (100, 125, 150)  # BGR
    ok, jpeg = cv2.imencode(".jpg", card)
    url = "data:image/jpeg;base64," + base64.b64encode(jpeg.tobytes()).decode()
    response = client.post(
        "/calibrate/white-balance",
        json={"roi": {"x": 0.3, "y": 0.3, "width": 0.4, "height": 0.4}, "imageDataUrl": url},
    )
    assert response.status_code == 200, response.text
    gains = response.json()["whiteBalance"]["gains"]
    assert gains[0] < 1 < gains[2], "should reduce red and boost blue"
    client.delete("/calibration")


def test_white_balance_rejects_clipped_reference(client):
    # The portrait's studio background is blown out to white, which cannot serve as a reference.
    response = client.post(
        "/calibrate/white-balance",
        json={"roi": {"x": 0.02, "y": 0.02, "width": 0.1, "height": 0.1}, "imageDataUrl": data_url(IMAGES / "portrait.png")},
    )
    assert response.status_code == 422


def test_calibrate_undertone_endpoint_fits_and_saves(client):
    rng = np.random.default_rng(1)
    samples = []
    for label, hue in (("warm", 66), ("cool", 42), ("neutral", 54)):
        for _ in range(7):
            h, chroma = np.radians(hue + rng.normal(0, 1.5)), 22
            samples.append({"L": float(rng.uniform(50, 70)), "a": chroma * np.cos(h), "b": chroma * np.sin(h),
                            "label": label})
    report = client.post("/calibrate/undertone", json={"samples": samples, "save": True}).json()
    assert report["saved"] is True and report["calibration"]["calibrated"] is True
    assert 50 < report["fitted"]["neutral_hue"] < 58
    assert report["heldOut"] > 0 and report["heldOutAccuracy"]["accuracy"] >= 0.75
    assert client.get("/calibration").json()["warmCool"]["calibrated"] is True
    assert client.post("/calibrate/undertone", json={"samples": samples[:3]}).status_code == 422
