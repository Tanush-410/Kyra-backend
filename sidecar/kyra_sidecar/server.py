"""HTTP API for the KYRA perception sidecar. Binds to localhost; the Node backend is its only client."""

import asyncio
import base64
import hmac
import json
import logging
import os
import time
from contextlib import asynccontextmanager

import cv2
import numpy as np
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel

from .calibration import Calibration
from .camera import CameraLoop
from .capture import build_bundle, decode_image, encode_jpeg, encode_png
from .color import gains_from_reference
from .compose import SIMILARITY_THRESHOLD, apply_clear_face, finish_render
from .config import Config
from . import undertone_adapter
from .capture import skin_config
from .perception import Perception, skin_sample
from .vendor.undertone import evaluate_warm_cool, fit_warm_cool

log = logging.getLogger("kyra.sidecar")


class ImageBody(BaseModel):
    imageDataUrl: str


class CompareBody(BaseModel):
    referenceDataUrl: str
    imageDataUrl: str


class ComposeBody(BaseModel):
    originalDataUrl: str
    generatedDataUrl: str
    keepMaskDataUrl: str
    referenceFaceDataUrl: str | None = None
    faceSourcePx: float | None = None
    upscale: float | None = None


class FaceTransferBody(BaseModel):
    imageDataUrl: str
    faceDataUrl: str


class ArmBody(BaseModel):
    sessionId: str


class HeightBody(BaseModel):
    heightCm: float
    imageDataUrl: str | None = None


class Roi(BaseModel):
    x: float
    y: float
    width: float
    height: float


class UndertoneSample(BaseModel):
    L: float
    a: float
    b: float
    label: str


class UndertoneBody(BaseModel):
    samples: list[UndertoneSample]
    save: bool = False


class WhiteBalanceBody(BaseModel):
    roi: Roi
    imageDataUrl: str | None = None
    # The card's printed L* (about 50 for an 18% grey card), if known: makes skin depth absolute.
    cardLightness: float | None = None


class EventHub:
    """Fan-out of sidecar events to SSE subscribers; publish() is safe to call from any thread."""

    def __init__(self):
        self.loop: asyncio.AbstractEventLoop | None = None
        self.queues: set[asyncio.Queue] = set()

    def publish(self, event: dict) -> None:
        if self.loop is None:
            return
        event = {**event, "at": time.time()}
        for queue in list(self.queues):
            self.loop.call_soon_threadsafe(_offer, queue, event)


def _offer(queue: asyncio.Queue, event: dict) -> None:
    if queue.full():
        queue.get_nowait()
    queue.put_nowait(event)


LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
SECURITY_HEADERS = [(b"x-content-type-options", b"nosniff"), (b"referrer-policy", b"no-referrer"),
                    (b"x-frame-options", b"DENY"), (b"cache-control", b"no-store")]


def host_name(host_header: str) -> str:
    """Host header without its port: "127.0.0.1:8765" -> "127.0.0.1", "[::1]:8765" -> "::1"."""
    host = host_header.strip().lower()
    if host.startswith("["):
        return host[1:host.find("]")] if "]" in host else host
    return host.rsplit(":", 1)[0] if host.count(":") == 1 else host


class RequestGuard:
    """Checks every request before the app sees it, and adds security headers to every response.

    - Host must be localhost or an allowed name (stops DNS rebinding).
    - Requests that change something must carry x-sidecar-token or x-kyra-client. A web page cannot add
      either header without a CORS preflight, which this server never grants, so cross-site requests such
      as a bodiless POST /disarm are refused.
    - Bodies over the size limit are refused before they are read; streamed bodies of unknown size too.
    """

    def __init__(self, app, allowed_hosts: set[str], max_body_bytes: int):
        self.app = app
        self.allowed_hosts = LOOPBACK_HOSTS | allowed_hosts
        self.max_body_bytes = max_body_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = {key.decode("latin-1").lower(): value.decode("latin-1") for key, value in scope["headers"]}
        problem = self._problem(scope["method"], headers)
        if problem:
            return await JSONResponse({"detail": problem[1]}, status_code=problem[0])(scope, receive, send)

        async def send_with_headers(message):
            if message["type"] == "http.response.start":
                existing = {key.lower() for key, _ in message.get("headers", [])}
                extra = [(key, value) for key, value in SECURITY_HEADERS if key not in existing]
                message = {**message, "headers": [*message.get("headers", []), *extra]}
            await send(message)

        await self.app(scope, receive, send_with_headers)

    def _problem(self, method: str, headers: dict) -> tuple[int, str] | None:
        if host_name(headers.get("host", "")) not in self.allowed_hosts:
            return 403, "Host not allowed"
        if method not in SAFE_METHODS:
            if not (headers.get("x-sidecar-token") or headers.get("x-kyra-client")):
                return 403, "Missing x-kyra-client header"
            length = headers.get("content-length")
            if length is None and "chunked" in headers.get("transfer-encoding", ""):
                return 411, "Content-Length required"
            if length is not None and (not length.isdigit() or int(length) > self.max_body_bytes):
                return 413, "Request body too large"
        return None


def create_app(config: Config | None = None, perception: Perception | None = None) -> FastAPI:
    config = config or Config()
    hub = EventHub()
    captures: dict[str, dict] = {}
    calibration = Calibration(config.calibration_path)
    state = {"perception": perception, "camera": None}

    def publish(event: dict) -> None:
        if event.get("type") == "capture":
            bundle = event.pop("bundle")
            captures[bundle["captureId"]] = bundle
            event["captureId"] = bundle["captureId"]
            event["guidance"] = bundle["guidance"]
        hub.publish(event)

    @asynccontextmanager
    async def lifespan(_app):
        hub.loop = asyncio.get_running_loop()
        if state["perception"] is None:
            state["perception"] = Perception(config.models_dir, live=config.camera_enabled)
        if config.camera_enabled:
            state["camera"] = CameraLoop(config, state["perception"], calibration, publish)
            state["camera"].start()
        sweeper = asyncio.create_task(_sweep_captures(captures, config.capture_ttl_s))
        yield
        sweeper.cancel()
        if state["camera"]:
            state["camera"].stop()

    def authorize(x_sidecar_token: str = Header(default="")):
        if config.token and not hmac.compare_digest(x_sidecar_token, config.token):
            raise HTTPException(401, "Invalid sidecar token")

    app = FastAPI(title="KYRA perception sidecar", lifespan=lifespan, dependencies=[Depends(authorize)])
    app.add_middleware(RequestGuard, allowed_hosts=set(config.allowed_hosts),
                       max_body_bytes=int(config.max_body_mb * 1024 * 1024))

    def camera() -> CameraLoop:
        if state["camera"] is None or state["camera"].status != "running":
            status = state["camera"].status if state["camera"] else "disabled"
            raise HTTPException(409, f"Camera is {status}")
        return state["camera"]

    def frame_for(image_data_url: str | None):
        if image_data_url:
            rgb = _decode(image_data_url)
            return rgb, state["perception"].analyze(rgb)
        frame, analysis = camera().latest()
        if frame is None:
            raise HTTPException(409, "No camera frame yet")
        return frame, analysis

    @app.get("/health")
    def health():
        cam = state["camera"]
        return {
            "ok": True,
            "camera": cam.status if cam else "disabled",
            "cameraError": cam.error if cam else "",
            "armedFor": cam.armed_for if cam else None,
            "calibration": calibration.summary(),
        }

    @app.get("/state")
    def current_state():
        return camera().state

    @app.get("/events")
    async def events(request: Request):
        queue: asyncio.Queue = asyncio.Queue(maxsize=100)
        hub.queues.add(queue)

        async def stream():
            try:
                cam = state["camera"]
                yield _sse({"type": "hello", "camera": cam.status if cam else "disabled", **(cam.state if cam else {})})
                while not await request.is_disconnected():
                    try:
                        event = await asyncio.wait_for(queue.get(), timeout=15)
                        yield _sse(event)
                    except asyncio.TimeoutError:
                        yield ": keep-alive\n\n"
            finally:
                hub.queues.discard(queue)

        return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})

    @app.get("/preview.mjpg")
    async def preview(request: Request):
        cam = camera()

        async def stream():
            last = None
            while not await request.is_disconnected():
                jpeg = cam.preview_jpeg()
                if jpeg is not None and jpeg is not last:
                    last = jpeg
                    yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + jpeg + b"\r\n"
                await asyncio.sleep(1 / 15)

        return StreamingResponse(stream(), media_type="multipart/x-mixed-replace; boundary=frame")

    @app.get("/frame.jpg")
    def latest_frame():
        """The latest full-resolution camera frame (rotated/mirrored as configured), for benchmarks and debugging."""
        frame, _ = camera().latest()
        if frame is None:
            raise HTTPException(409, "No camera frame yet")
        ok, jpeg = cv2.imencode(".jpg", cv2.cvtColor(frame, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 92])
        return Response(content=jpeg.tobytes(), media_type="image/jpeg")

    @app.post("/arm")
    def arm(body: ArmBody):
        camera().arm(body.sessionId)
        return {"armed": body.sessionId}

    @app.post("/disarm")
    def disarm():
        camera().disarm()
        return {"armed": None}

    @app.post("/capture")
    def capture_now():
        bundle = camera().capture_now()
        if bundle is None:
            raise HTTPException(409, "Nobody is in frame")
        captures[bundle["captureId"]] = bundle
        return bundle

    @app.get("/captures/{capture_id}")
    def get_capture(capture_id: str):
        if capture_id not in captures:
            raise HTTPException(404, "Capture not found")
        return captures[capture_id]

    @app.delete("/captures/{capture_id}")
    def delete_capture(capture_id: str):
        return {"deleted": captures.pop(capture_id, None) is not None}

    @app.post("/analyze")
    def analyze(body: ImageBody):
        rgb = _decode(body.imageDataUrl)
        analysis = state["perception"].analyze(rgb)
        if not analysis.present:
            sample = None
        elif config.undertone_engine == "legacy":
            sample = skin_sample(rgb, analysis, calibration.white_balance_gains())
        else:
            sample = undertone_adapter.measure_frame(rgb, analysis.face_landmarks, analysis.person_mask,
                                                     calibration.reference_rgb(), skin_config(calibration),
                                                     people_mask=analysis.people_mask, **calibration.card_settings())
        return build_bundle(rgb, analysis, [sample] if sample and "lab" in sample else [], state["perception"],
                            calibration, "still", mirrored=False)

    @app.post("/segment")
    def segment(body: ImageBody):
        rgb = _decode(body.imageDataUrl)
        analysis = state["perception"].analyze(rgb)
        mask = np.zeros(rgb.shape[:2], dtype=np.uint8)
        if analysis.person_mask is not None:
            mask = (cv2.resize(analysis.person_mask, (rgb.shape[1], rgb.shape[0])) * 255).astype(np.uint8)
        return {"personFound": analysis.present, "maskDataUrl": encode_png(mask)}

    @app.post("/face/compare")
    def compare(body: CompareBody):
        reference = state["perception"].face_identity(_decode(body.referenceDataUrl))
        candidate = state["perception"].face_identity(_decode(body.imageDataUrl))
        if reference is None or candidate is None:
            return {"faceFound": False, "referenceFound": reference is not None, "imageFound": candidate is not None}
        similarity = float(reference["embedding"] @ candidate["embedding"])
        rb, cb = reference["box"], candidate["box"]
        shift = float(np.hypot((rb["x"] + rb["width"] / 2) - (cb["x"] + cb["width"] / 2),
                               (rb["y"] + rb["height"] / 2) - (cb["y"] + cb["height"] / 2)))
        return {
            "faceFound": True,
            "similarity": round(similarity, 4),
            "samePerson": similarity >= SIMILARITY_THRESHOLD,
            "threshold": SIMILARITY_THRESHOLD,
            "shift": round(shift, 4),
            "scaleRatio": round(cb["height"] / max(rb["height"], 1e-6), 4),
            "referenceBox": rb,
            "imageBox": cb,
        }

    @app.post("/compose")
    def compose(body: ComposeBody):
        original = _decode(body.originalDataUrl)
        generated = _decode(body.generatedDataUrl)
        keep = cv2.cvtColor(_decode(body.keepMaskDataUrl), cv2.COLOR_RGB2GRAY)
        if keep.shape[:2] != original.shape[:2]:
            keep = cv2.resize(keep, (original.shape[1], original.shape[0]))
        reference = _decode(body.referenceFaceDataUrl) if body.referenceFaceDataUrl else None
        debug_dir = os.environ.get("COMPOSE_DEBUG_DIR")
        if debug_dir:  # opt-in: keep the raw inputs so compose can be re-run offline while tuning
            stamp = str(int(time.time() * 1000))
            for name, image in (("original", original), ("generated", generated), ("keep", keep)):
                cv2.imwrite(os.path.join(debug_dir, f"{stamp}-{name}.png"), image if image.ndim == 2 else cv2.cvtColor(image, cv2.COLOR_RGB2BGR))
        result = finish_render(state["perception"], original, generated, keep, reference, body.faceSourcePx, body.upscale,
                               paste_hands=config.compose_hands, match_body=config.compose_silhouette)
        ok, png = cv2.imencode(".png", cv2.cvtColor(result.pop("image"), cv2.COLOR_RGB2BGR))
        return {"imageDataUrl": "data:image/png;base64," + base64.b64encode(png.tobytes()).decode(), **result}

    @app.get("/face/best")
    def best_face():
        """The clearest face seen so far this visit (512 x 512 JPEG), for updating a finished look."""
        face = camera().best_face()
        if face is None:
            raise HTTPException(404, "No face seen yet")
        return {"imageDataUrl": encode_jpeg(face["image"]), "score": face["score"], "facePx": round(face["facePx"], 1),
                "quality": face.get("quality")}

    @app.post("/face/transfer")
    def face_transfer(body: FaceTransferBody):
        """Puts a close-up's face onto a finished look, if safe (facetransfer.py). Free: no OpenAI call."""
        image, report = apply_clear_face(state["perception"], _decode(body.imageDataUrl), _decode(body.faceDataUrl))
        ok, png = cv2.imencode(".png", cv2.cvtColor(image, cv2.COLOR_RGB2BGR))
        return {"applied": report["applied"], "report": report,
                "imageDataUrl": "data:image/png;base64," + base64.b64encode(png.tobytes()).decode() if report["applied"] else None}

    @app.get("/calibration")
    def get_calibration():
        return calibration.summary()

    @app.delete("/calibration")
    def reset_calibration():
        return calibration.reset()

    @app.post("/calibrate/height")
    def calibrate_height(body: HeightBody):
        if not 100 <= body.heightCm <= 230:
            raise HTTPException(400, "heightCm must be between 100 and 230")
        _rgb, analysis = frame_for(body.imageDataUrl)
        if not (analysis and analysis.full_body and analysis.standing):
            raise HTTPException(422, "The reference person must be standing, fully in frame, head to toe")
        return calibration.add_height_sample(analysis.foot_y, analysis.pixel_height, body.heightCm)

    @app.post("/calibrate/undertone")
    def calibrate_undertone(body: UndertoneBody):
        """Fit the detector's warm/cool anchors from visitors' confirmed undertones, and report held-out accuracy."""
        samples = [s.model_dump() for s in body.samples]
        if len(samples) < 6:
            raise HTTPException(422, f"need at least 6 labelled samples, got {len(samples)}")
        holdout = samples[::5] if len(samples) >= 15 else []
        train = [s for i, s in enumerate(samples) if not (holdout and i % 5 == 0)]
        try:
            fitted = fit_warm_cool(train)
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        default = undertone_adapter.make_config(None, calibration.white_balance is not None)
        report = {
            "fitted": fitted.to_dict(),
            "trainedOn": len(train),
            "heldOut": len(holdout),
            "heldOutAccuracy": evaluate_warm_cool(holdout, fitted.apply(default)) if holdout else None,
            "defaultAccuracyOnHeldOut": evaluate_warm_cool(holdout, default) if holdout else None,
        }
        if body.save:
            calibration.set_warm_cool(fitted.to_dict())
        return {**report, "saved": body.save, "calibration": calibration.summary()["warmCool"]}

    @app.post("/calibrate/white-balance")
    def calibrate_white_balance(body: WhiteBalanceBody):
        rgb, _analysis = frame_for(body.imageDataUrl)
        h, w = rgb.shape[:2]
        roi = body.roi
        x0, y0 = int(roi.x * w), int(roi.y * h)
        x1, y1 = int((roi.x + roi.width) * w), int((roi.y + roi.height) * h)
        patch = rgb[max(0, y0):min(h, y1), max(0, x0):min(w, x1)]
        if patch.size < 300:
            raise HTTPException(400, "roi is too small or outside the frame")
        mean = patch.reshape(-1, 3).mean(axis=0)
        if mean.min() < 40 or mean.max() > 250:
            raise HTTPException(422, "Reference patch is too dark or clipped; use a matte grey or white card")
        return calibration.set_white_balance(gains_from_reference(patch), mean.tolist(), roi.model_dump(),
                                             body.cardLightness)

    return app


def _decode(data_url: str) -> np.ndarray:
    try:
        return decode_image(data_url)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


def _sse(event: dict) -> str:
    return f"event: {event.get('type', 'message')}\ndata: {json.dumps(event)}\n\n"


async def _sweep_captures(captures: dict, ttl_s: int) -> None:
    while True:
        await asyncio.sleep(30)
        cutoff = time.time() - ttl_s
        for capture_id in [cid for cid, bundle in captures.items() if bundle["createdAt"] < cutoff]:
            captures.pop(capture_id, None)
