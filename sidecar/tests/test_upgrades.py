"""Matte, compose (head and hand paste), gestures and the camera watchdog."""

import base64
import os
from pathlib import Path
from types import SimpleNamespace

import cv2
import numpy as np
import pytest

from kyra_sidecar.camera import CameraLoop, crop_to_aspect
from kyra_sidecar.perception import refine_mask

MODELS = Path(__file__).resolve().parent.parent / "models"
IMAGES = Path(os.environ.get("KYRA_TEST_IMAGES", "/nonexistent"))
needs_models = pytest.mark.skipif(
    not (MODELS / "pose_landmarker_full.task").exists() or not (IMAGES / "standing.png").exists(),
    reason="needs downloaded models and KYRA_TEST_IMAGES with standing.png and render.png",
)


def test_refine_mask_snaps_to_edges_and_drops_the_fringe():
    image = np.zeros((200, 200, 3), np.uint8)
    image[:, 100:] = 200  # a hard edge at x=100
    coarse = cv2.GaussianBlur((image[..., 0] > 0).astype(np.float32), (0, 0), 8)  # blurry segmentation
    matte = refine_mask(image, coarse)
    assert matte[:, 120].min() > 0.95 and matte[:, 80].max() < 0.05
    assert ((matte > 0.05) & (matte < 0.95)).mean() < ((coarse > 0.05) & (coarse < 0.95)).mean()


def loop_for_test(**overrides):
    config = SimpleNamespace(gesture_hold_ms=600, gesture_cooldown_ms=2000, freeze_after_s=5, **overrides)
    events = []
    loop = CameraLoop.__new__(CameraLoop)
    loop.config, loop.publish = config, events.append
    loop._gesture_candidate, loop._gesture_cooldown_until, loop._armed_for = None, 0.0, None
    loop._last_thumb, loop._unchanged_since = None, None
    return loop, events


def test_preview_crop_keeps_the_centre_strip_at_full_resolution():
    frame = np.zeros((1080, 1920, 3), np.uint8)
    frame[:, 950:970] = 255  # a line down the middle
    strip = crop_to_aspect(frame, 1080 / 3840, 1920)
    assert strip.shape[:2] == (1080, 304), "a portrait strip of a landscape camera, full height, never upscaled"
    assert strip[:, 140:160].mean() > 200, "cut from the centre"
    assert crop_to_aspect(frame, 1080 / 3840, 720).shape[:2] == (720, 203), "scaled down to the height asked for"
    tall = crop_to_aspect(np.zeros((1920, 1080, 3), np.uint8), 16 / 9, 4000)
    assert tall.shape[:2] == (608, 1080), "a portrait camera on a landscape screen keeps the full width"


def test_preview_crop_is_encoded_once_per_frame_and_shape():
    loop = CameraLoop.__new__(CameraLoop)
    loop._preview_bgr, loop._preview_seq, loop._crop_cache = None, 0, {}
    assert loop.preview_crop_jpeg(0.28, 1080) is None, "nothing before the first frame"
    loop._preview_bgr, loop._preview_seq = np.full((1080, 1920, 3), 128, np.uint8), 1
    first = loop.preview_crop_jpeg(0.28, 1080)
    assert loop.preview_crop_jpeg(0.28, 1080) is first, "two screens on the same frame share one encoding"
    assert cv2.imdecode(np.frombuffer(first[1], np.uint8), cv2.IMREAD_COLOR).shape[:2] == (1080, 302)
    loop._preview_seq = 2
    assert loop.preview_crop_jpeg(0.28, 1080)[0] == 2, "a new frame is encoded again"
    assert all(entry[0] == 2 for entry in loop._crop_cache.values()), "old frames are dropped"


def test_gesture_must_be_held_then_cools_down():
    loop, events = loop_for_test()
    loop._track_gesture(("thumb_up", 0.9), 0.0)
    loop._track_gesture(("thumb_up", 0.9), 0.3)
    assert events == []
    loop._track_gesture(("thumb_up", 0.9), 0.7)
    assert [e["gesture"] for e in events] == ["thumb_up"]
    for t in (0.8, 1.6, 2.4):
        loop._track_gesture(("thumb_up", 0.9), t)
    assert len(events) == 1, "ignored during the cooldown"
    loop._track_gesture(("victory", 0.95), 3.0)
    loop._track_gesture(("victory", 0.95), 3.7)
    assert [e["gesture"] for e in events] == ["thumb_up", "victory"]


def test_gesture_needs_confidence_and_consistency():
    loop, events = loop_for_test()
    for t, g in [(0.0, ("thumb_up", 0.5)), (0.7, ("thumb_up", 0.5)), (1.0, ("thumb_up", 0.9)), (1.4, ("thumb_down", 0.9)), (1.8, ("thumb_up", 0.9))]:
        loop._track_gesture(g, t)
    assert events == []


def test_watchdog_flags_identical_frames_but_not_sensor_noise():
    loop, _ = loop_for_test()
    frame = np.full((360, 640, 3), 90, np.uint8)
    # The freeze clock starts at the second identical frame (t=2), so it trips once 5 s have passed.
    assert not any(loop._frozen(frame, t) for t in (0, 2, 4, 6))
    assert loop._frozen(frame, 8)

    loop, _ = loop_for_test()
    rng = np.random.default_rng(0)
    noisy = [np.clip(frame.astype(np.int16) + rng.integers(-3, 4, frame.shape), 0, 255).astype(np.uint8) for _ in range(8)]
    assert not any(loop._frozen(f, t) for t, f in enumerate(noisy))


def _url(path: Path) -> str:
    return "data:image/png;base64," + base64.b64encode(path.read_bytes()).decode()


def _decode(url: str) -> np.ndarray:
    return cv2.imdecode(np.frombuffer(base64.b64decode(url.split(",", 1)[1]), np.uint8), cv2.IMREAD_COLOR)


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    from fastapi.testclient import TestClient

    from kyra_sidecar.config import Config
    from kyra_sidecar.server import create_app

    config = Config()
    config.camera_enabled = False
    config.calibration_path = tmp_path_factory.mktemp("cal") / "calibration.json"
    with TestClient(create_app(config), base_url="http://127.0.0.1:8765", headers={"x-kyra-client": "tests"}) as test_client:
        yield test_client


@needs_models
def test_compose_pastes_real_head_and_hands_on_an_aligned_render(client):
    bundle = client.post("/analyze", json={"imageDataUrl": _url(IMAGES / "standing.png")}).json()
    render = bundle["render"]
    result = client.post("/compose", json={
        "originalDataUrl": render["imageDataUrl"],
        "generatedDataUrl": _url(IMAGES / "render.png"),
        "keepMaskDataUrl": render["keepMaskDataUrl"],
    }).json()
    assert result["headPasted"] is True
    assert result["alignment"]["shift"] < 0.03
    assert result["samePerson"] is True and result["similarity"] > 0.9
    assert set(result["handsPasted"]) <= {"left", "right"}

    final = _decode(result["imageDataUrl"])
    original = _decode(render["imageDataUrl"])
    assert final.shape == (1536, 1024, 3)
    assert final[:20, :20].max() < 8, "background is black"
    face = bundle["render"]["faceBox"]
    y0, y1 = int(face["y"] * 1536), int((face["y"] + face["height"]) * 1536)
    x0, x1 = int(face["x"] * 1024), int((face["x"] + face["width"]) * 1024)
    assert np.abs(final[y0:y1, x0:x1].astype(int) - original[y0:y1, x0:x1].astype(int)).mean() < 6, "face pixels are the original's"


def _compose(client, render, generated: np.ndarray) -> dict:
    ok, png = cv2.imencode(".png", generated)
    return client.post("/compose", json={
        "originalDataUrl": render["imageDataUrl"],
        "generatedDataUrl": "data:image/png;base64," + base64.b64encode(png.tobytes()).decode(),
        "keepMaskDataUrl": render["keepMaskDataUrl"],
    }).json()


@needs_models
def test_compose_warps_a_shifted_render_back_into_place(client):
    render = client.post("/analyze", json={"imageDataUrl": _url(IMAGES / "standing.png")}).json()["render"]
    moved = np.roll(_decode(_url(IMAGES / "render.png")), 160, axis=1)  # person shifted 160 px sideways
    result = _compose(client, render, moved)
    assert result["warp"] is not None and result["warp"]["dx"] < -0.12, "warp undoes the shift"
    assert result["headPasted"] is True
    assert result["samePerson"] is True


@needs_models
def test_compose_refuses_to_paste_when_the_render_cannot_be_aligned(client):
    render = client.post("/analyze", json={"imageDataUrl": _url(IMAGES / "standing.png")}).json()["render"]
    generated = _decode(_url(IMAGES / "render.png"))
    zoomed = cv2.resize(generated, None, fx=1.4, fy=1.4)[300:1836, 205:1229]  # 40% larger: beyond the warp limit
    result = _compose(client, render, zoomed)
    assert result["warp"] is None
    assert result["headPasted"] is False
    assert result["handsPasted"] == []


def test_early_profile_is_sent_once_stable_and_again_only_when_it_changes():
    from kyra_sidecar.calibration import Calibration
    from kyra_sidecar.perception import FrameAnalysis

    loop, events = loop_for_test()
    loop._armed_for, loop._early_profile_key, loop._early_profile_at = "s1", None, 0.0
    loop.calibration = Calibration(Path("/nonexistent/calibration.json"))
    sample = {"lab": np.array([62.0, 14.0, 26.0]), "count": 400, "whiteBalance": "gray-world"}  # hue 61.7 degrees: warm
    analysis = FrameAnalysis(width=10, height=10, person_count=1, landmarks=np.zeros((33, 4)))

    loop._skin = [sample] * 5
    loop._send_early_profile(analysis, 10.0)
    assert events == [], "not stable yet"
    loop._skin = [sample] * 10
    loop._send_early_profile(analysis, 10.0)
    assert [e["type"] for e in events] == ["profile"] and events[0]["sessionId"] == "s1"
    assert events[0]["profile"]["skin"]["skinUndertone"] == "warm"
    loop._send_early_profile(analysis, 20.0)
    assert len(events) == 1, "unchanged profile is not resent"
    loop._early_profile_at = 20.0  # pretend a send just happened, to check the rate limit
    loop._skin = [{**sample, "lab": np.array([62.0, 20.0, 10.0])}] * 10
    loop._send_early_profile(analysis, 20.5)
    assert len(events) == 1, "rate limited within 1.5 s of the last send"
    loop._send_early_profile(analysis, 22.0)
    assert events[-1]["profile"]["skin"]["skinUndertone"] == "cool"


def test_undertone_thresholds_come_from_the_environment(monkeypatch):
    import importlib

    import kyra_sidecar.color as color

    monkeypatch.setenv("SKIN_COOL_MAX_HUE", "45")
    monkeypatch.setenv("SKIN_WARM_MIN_HUE", "62")
    reloaded = importlib.reload(color)
    try:
        assert reloaded.classify_undertone(47) == "neutral"
        assert reloaded.classify_undertone(61) == "neutral"
        assert reloaded.classify_undertone(63) == "warm"
    finally:
        monkeypatch.delenv("SKIN_COOL_MAX_HUE")
        monkeypatch.delenv("SKIN_WARM_MIN_HUE")
        importlib.reload(color)


def test_guidance_smoother_ignores_one_frame_blips():
    from kyra_sidecar.guidance import MESSAGES, GuidanceSmoother

    smoother = GuidanceSmoother(frames=3)
    g = lambda s: {"state": s, "message": MESSAGES[s], "ready": s == "ready"}
    seen = [smoother.update(g(s))["state"] for s in
            ["too_close", "ready", "too_close", "ready", "ready", "ready", "too_close", "ready", "ready"]]
    assert seen == ["too_close", "too_close", "too_close", "too_close", "too_close", "ready", "ready", "ready", "ready"]


def test_any_head_to_toe_framing_is_ready_so_closer_and_back_never_fight():
    from kyra_sidecar.guidance import evaluate
    from tests.test_units import standing_person

    # Anywhere from half the frame to nearly all of it, with head and feet in, is a valid spot to stand.
    for head_top_y in (0.05, 0.15, 0.3, 0.42):
        assert evaluate(standing_person(head_top_y=head_top_y, foot_y=0.94))["state"] == "ready", head_top_y
    assert evaluate(standing_person(head_top_y=0.5, foot_y=0.94))["state"] == "too_far"


def test_head_mask_covers_face_and_hair_but_not_the_neck_or_collar():
    from kyra_sidecar.perception import FrameAnalysis, head_mask

    landmarks = np.zeros((478, 2))
    # A face oval centred at (0.5, 0.3), 0.2 wide and 0.26 tall; eye corners at y=0.27, chin at y=0.43.
    angles = np.linspace(0, 2 * np.pi, 478, endpoint=False)
    landmarks[:, 0] = 0.5 + 0.1 * np.cos(angles)
    landmarks[:, 1] = 0.3 + 0.13 * np.sin(angles)
    landmarks[[33, 263]] = [[0.45, 0.27], [0.55, 0.27]]
    landmarks[152] = [0.5, 0.43]
    analysis = FrameAnalysis(width=100, height=100, face_landmarks=landmarks)
    person = np.zeros((100, 100), np.uint8)
    person[5:100, 30:70] = 255  # hair above, neck and shirt below
    mask = head_mask(analysis, 100, 100, person)
    assert mask[8, 50] == 255, "hair above the eyes is kept"
    assert mask[50, 35] == 0, "collar beside the neck is not pasted"
    assert mask[47, 50] == 0, "neck below the chin is left to the render"
    assert mask[30, 50] == 255, "face is kept"


@needs_models
def test_compose_matches_the_visitors_silhouette_and_skips_pasting_an_enlarged_face(client):
    render = client.post("/analyze", json={"imageDataUrl": _url(IMAGES / "standing.png")}).json()["render"]
    generated = _decode(_url(IMAGES / "render.png"))
    base = {"originalDataUrl": render["imageDataUrl"], "keepMaskDataUrl": render["keepMaskDataUrl"]}
    ok, png = cv2.imencode(".png", generated)
    gen_url = "data:image/png;base64," + base64.b64encode(png.tobytes()).decode()

    sharp = client.post("/compose", json={**base, "generatedDataUrl": gen_url, "faceSourcePx": 120, "upscale": 1.0}).json()
    assert sharp["silhouette"]["applied"] is True
    assert sharp["silhouette"]["widthErrorAfter"] < sharp["silhouette"]["widthErrorBefore"]
    assert sharp["headDecision"] == "pasted"

    enlarged = client.post("/compose", json={**base, "generatedDataUrl": gen_url, "faceSourcePx": 45, "upscale": 2.5}).json()
    assert enlarged["headDecision"].startswith("kept render face"), enlarged["headDecision"]
    assert enlarged["samePerson"] is True
