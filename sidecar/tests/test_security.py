"""The sidecar's request guard: DNS rebinding, cross-site requests, oversized bodies, decompression bombs."""

import base64

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from kyra_sidecar.config import Config
from kyra_sidecar.server import create_app, host_name

LOCAL = "http://127.0.0.1:8765"


@pytest.fixture(scope="module")
def app(tmp_path_factory):
    config = Config()
    config.camera_enabled = False
    config.token = ""
    config.max_body_mb = 1
    config.calibration_path = tmp_path_factory.mktemp("cal") / "calibration.json"
    return create_app(config, perception=object())  # no models needed: the guard runs before any handler


def test_host_names_are_read_without_their_port():
    assert host_name("127.0.0.1:8765") == "127.0.0.1"
    assert host_name("[::1]:8765") == "::1"
    assert host_name("LocalHost") == "localhost"


def test_requests_addressed_to_another_host_are_refused(app):
    with TestClient(app, base_url=LOCAL) as client:
        assert client.get("/health").status_code == 200
        assert client.get("/health", headers={"host": "[::1]:8765"}).status_code == 200
        rebound = client.get("/calibration", headers={"host": "attacker.example:8765"})
        assert rebound.status_code == 403 and rebound.json()["detail"] == "Host not allowed"


def test_cross_site_requests_cannot_change_anything(app):
    with TestClient(app, base_url=LOCAL) as client:
        # What a web page can send without a preflight: a bodiless POST with no custom headers.
        assert client.post("/disarm").status_code == 403
        assert client.delete("/calibration").status_code == 403
        # The backend identifies itself; then the request reaches the handler (camera is off here).
        assert client.post("/disarm", headers={"x-kyra-client": "kyra-backend"}).status_code == 409


def test_oversized_and_unsized_bodies_are_refused_before_reading(app):
    with TestClient(app, base_url=LOCAL, headers={"x-kyra-client": "tests"}) as client:
        big = client.post("/segment", content=b"x" * (1024 * 1024 + 1), headers={"content-type": "application/json"})
        assert big.status_code == 413
        chunked = client.post("/segment", content=iter([b"{}"]), headers={"content-type": "application/json"})
        assert chunked.status_code == 411


def test_decompression_bombs_are_refused(app):
    _, png = cv2.imencode(".png", np.zeros((8000, 8000), np.uint8))  # 64 megapixels in ~70 KB
    url = "data:image/png;base64," + base64.b64encode(png.tobytes()).decode()
    with TestClient(app, base_url=LOCAL, headers={"x-kyra-client": "tests"}) as client:
        response = client.post("/segment", json={"imageDataUrl": url})
    assert response.status_code == 400 and "too large" in response.json()["detail"]


def test_every_response_carries_security_headers(app):
    with TestClient(app, base_url=LOCAL) as client:
        headers = client.get("/health").headers
    assert headers["x-content-type-options"] == "nosniff"
    assert headers["referrer-policy"] == "no-referrer"
    assert headers["x-frame-options"] == "DENY"
    assert headers["cache-control"] == "no-store"


def test_render_finishing_extras_are_off_by_default(monkeypatch):
    # 7 Nov 2026: on a webcam capture, pasting real hands and matching the body outline caused visible artifacts.
    monkeypatch.delenv("COMPOSE_HANDS", raising=False)
    monkeypatch.delenv("COMPOSE_SILHOUETTE", raising=False)
    assert Config().compose_hands is False and Config().compose_silhouette is False
    monkeypatch.setenv("COMPOSE_HANDS", "true")
    assert Config().compose_hands is True
