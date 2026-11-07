"""Builds the capture bundle the backend renders from: a 1024x1536 cut-out, masks and the measured profile."""

import base64
import os
import struct
import time
import uuid

import cv2
import numpy as np

from .calibration import Calibration
from .color import describe_lab
from .guidance import evaluate
from .perception import FrameAnalysis, Perception, body_frame, face_width_px, head_mask, refine_mask
from . import undertone_adapter

RENDER_W, RENDER_H = 1024, 1536
MAX_IMAGE_PIXELS = int(os.environ.get("OPENCV_IO_MAX_IMAGE_PIXELS") or 40_000_000)
_JPEG_SOF = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}


def image_dimensions(raw: bytes) -> tuple[int, int] | None:
    """(width, height) from a PNG, JPEG or WebP header, without decoding; None for other formats."""
    if raw[:8] == b"\x89PNG\r\n\x1a\n" and len(raw) >= 24:
        return struct.unpack(">II", raw[16:24])
    if raw[:2] == b"\xff\xd8":
        i = 2
        while i + 9 < len(raw):
            if raw[i] != 0xFF:
                i += 1
                continue
            marker = raw[i + 1]
            if marker == 0xFF or marker == 0x01 or 0xD0 <= marker <= 0xD8:
                i += 1 if marker == 0xFF else 2
                continue
            if marker in _JPEG_SOF:
                height, width = struct.unpack(">HH", raw[i + 5:i + 9])
                return width, height
            i += 2 + struct.unpack(">H", raw[i + 2:i + 4])[0]
        return None
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP" and len(raw) >= 30:
        chunk = raw[12:16]
        if chunk == b"VP8X":
            return 1 + int.from_bytes(raw[24:27], "little"), 1 + int.from_bytes(raw[27:30], "little")
        if chunk == b"VP8 ":
            width, height = struct.unpack("<HH", raw[26:30])
            return width & 0x3FFF, height & 0x3FFF
        if chunk == b"VP8L":
            b = raw[21:25]
            return 1 + (((b[1] & 0x3F) << 8) | b[0]), 1 + (((b[3] & 0x0F) << 10) | (b[2] << 2) | ((b[1] & 0xC0) >> 6))
    return None


def jsonable(value):
    """Recursively convert numpy scalars and arrays to plain Python for JSON responses."""
    if isinstance(value, dict):
        return {key: jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(item) for item in value]
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, np.generic):
        return value.item()
    return value


def encode_png(image: np.ndarray) -> str:
    ok, data = cv2.imencode(".png", image)
    return "data:image/png;base64," + base64.b64encode(data.tobytes()).decode() if ok else ""


def encode_jpeg(rgb: np.ndarray, quality: int = 92) -> str:
    ok, data = cv2.imencode(".jpg", cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, quality])
    return "data:image/jpeg;base64," + base64.b64encode(data.tobytes()).decode() if ok else ""


def decode_image(data_url: str) -> np.ndarray:
    """data:image/...;base64 → RGB uint8."""
    if not isinstance(data_url, str) or "," not in data_url:
        raise ValueError("imageDataUrl must be a base64 data URL")
    raw = base64.b64decode(data_url.split(",", 1)[1])
    # A tiny file can claim billions of pixels (a decompression bomb): check the header before decoding.
    # OpenCV's own limit (set in kyra_sidecar/__init__.py) is the second line of defence.
    size = image_dimensions(raw)
    if size and size[0] * size[1] > MAX_IMAGE_PIXELS:
        raise ValueError("Image is too large")
    try:
        bgr = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    except cv2.error as error:  # over OPENCV_IO_MAX_IMAGE_PIXELS (see kyra_sidecar/__init__.py)
        raise ValueError("Image is too large") from error
    if bgr is None:
        raise ValueError("Could not decode image")
    return cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)


def aggregate_skin(samples: list[dict]) -> dict | None:
    if not samples:
        return None
    labs = np.array([s["lab"] for s in samples])
    lab = np.median(labs, axis=0)
    hues = np.degrees(np.arctan2(labs[:, 2], labs[:, 1]))
    calibrated = all(s["whiteBalance"] == "calibrated" for s in samples)
    pixels = sum(s["count"] for s in samples)
    spread = float(hues.std()) if len(samples) > 1 else 0.0

    if len(samples) >= 8 and spread < 3 and calibrated:
        confidence = "high"
    elif len(samples) >= 3 or pixels >= 600:
        confidence = "medium"
    else:
        confidence = "low"
    return {
        "method": "face-mesh",
        **describe_lab(lab),
        "whiteBalance": "calibrated" if calibrated else "gray-world",
        "framesUsed": len(samples),
        "sampleCount": pixels,
        "hueSpread": round(spread, 2),
        "confidence": confidence,
    }


def skin_config(calibration: Calibration):
    return undertone_adapter.make_config(calibration.warm_cool, calibration.white_balance is not None)


def visitor_profile(analysis: FrameAnalysis, skin_samples: list[dict], calibration: Calibration) -> dict:
    """Skin, height and build: what the outfit design needs. Shared by captures and early profiles.

    Skin samples come from the undertone detector (undertone_adapter.measure_frame); the legacy
    single-patch samples (perception.skin_sample) are still accepted.
    """
    detector_samples = [s for s in skin_samples if s and "facePx" in s]
    skin = (undertone_adapter.aggregate(detector_samples, skin_config(calibration)) if detector_samples
            else aggregate_skin([s for s in skin_samples if s and "facePx" not in s]))
    height_px = analysis.pixel_height or 0.0
    height_cm = (calibration.estimate_height_cm(analysis.foot_y or 0.0, height_px)
                 if analysis.standing and analysis.full_body else None)
    return {
        "skin": skin,
        "height": {
            "cm": height_cm,
            "method": "calibrated" if height_cm else "none",
            "pixelHeight": round(height_px, 4),
            "footY": round(analysis.foot_y or 0.0, 4),
        },
        "frame": body_frame(analysis),
    }


def crop_box(analysis: FrameAnalysis, width: int, height: int) -> tuple[int, int, int, int]:
    """2:3 portrait box (pixels, may extend past the frame) framing the person head to toe."""
    x0, y0, x1, y1 = analysis.bbox or (0.0, 0.0, 1.0, 1.0)
    top = (analysis.head_top_y if analysis.head_top_y is not None else y0) * height
    bottom = max(y1, analysis.foot_y or y1) * height
    person_h = max(1.0, bottom - top)
    box_h = person_h / 0.9
    box_w = max(box_h * RENDER_W / RENDER_H, (x1 - x0) * width * 1.08)
    box_h = box_w * RENDER_H / RENDER_W
    cx = (x0 + x1) / 2 * width
    cy = (top + bottom) / 2
    return int(round(cx - box_w / 2)), int(round(cy - box_h / 2)), int(round(box_w)), int(round(box_h))


def _crop_resize(image: np.ndarray, box: tuple[int, int, int, int], interpolation) -> np.ndarray:
    x, y, w, h = box
    ih, iw = image.shape[:2]
    pad = ((max(0, -y), max(0, y + h - ih)), (max(0, -x), max(0, x + w - iw))) + ((0, 0),) * (image.ndim - 2)
    padded = np.pad(image, pad)
    cropped = padded[y + pad[0][0]:y + pad[0][0] + h, x + pad[1][0]:x + pad[1][0] + w]
    return cv2.resize(cropped, (RENDER_W, RENDER_H), interpolation=interpolation)


def build_bundle(
    rgb: np.ndarray,
    analysis: FrameAnalysis,
    skin_samples: list[dict],
    perception: Perception,
    calibration: Calibration,
    source: str,
    mirrored: bool = True,
    face_ref: dict | None = None,
) -> dict:
    """rgb is the full-resolution frame; analysis may come from a downscaled copy (coordinates are normalized)."""
    height, width = rgb.shape[:2]
    person_full = np.zeros((height, width), dtype=np.uint8)
    if analysis.person_mask is not None:
        person_full = (cv2.resize(analysis.person_mask, (width, height), interpolation=cv2.INTER_LINEAR) * 255).astype(np.uint8)
    head_full = head_mask(analysis, width, height, person_full)

    box = crop_box(analysis, width, height)
    image = _crop_resize(rgb, box, cv2.INTER_CUBIC)
    head = _crop_resize(head_full, box, cv2.INTER_NEAREST)
    # Edge-aware matte at render size: clean hair edges, no background halo.
    matte = refine_mask(image, _crop_resize(person_full, box, cv2.INTER_LINEAR).astype(np.float32) / 255.0)
    person = (matte * 255).astype(np.uint8)

    # Cut-out on black: the mirror shows black as glass, and the model sees no background to copy.
    cutout = (image.astype(np.float32) * matte[..., None]).astype(np.uint8)

    # Editable = the person grown so new garments can change the silhouette, minus the head.
    grow = max(3, int(RENDER_W * 0.045))
    editable = cv2.dilate((person > 127).astype(np.uint8) * 255, np.ones((grow, grow), np.uint8))
    editable[cv2.dilate(head, np.ones((9, 9), np.uint8)) > 0] = 0
    edit_mask = np.zeros((RENDER_H, RENDER_W, 4), dtype=np.uint8)
    edit_mask[..., 3] = np.where(editable > 0, 0, 255)  # OpenAI: transparent = may be edited

    # Soft keep-mask for pasting the original head back. It stops a few pixels inside the matte so the
    # hair's outer fringe (where the room or a white wall shows through) is never pasted.
    keep = cv2.GaussianBlur(cv2.erode(head, np.ones((5, 5), np.uint8)), (0, 0), RENDER_W * 0.006)
    inner_matte = cv2.erode(matte, np.ones((3, 3), np.uint8), iterations=2)
    keep = (keep.astype(np.float32) * inner_matte).astype(np.uint8)

    identity = perception.face_identity(cutout)

    return jsonable({
        "captureId": uuid.uuid4().hex,
        "createdAt": time.time(),
        "source": source,
        # "Step closer" for a small face only makes sense live; a still photo is judged on everything else.
        "guidance": evaluate(analysis, mirrored=mirrored),
        "checks": {
            "personCount": analysis.person_count,
            "fullBody": analysis.full_body,
            "standing": analysis.standing,
            "faceVisible": analysis.face_visible,
            "sharpness": round(analysis.sharpness, 1),
            "luminance": round(analysis.luminance, 1),
        },
        "profile": visitor_profile(analysis, skin_samples, calibration),
        "render": {
            "width": RENDER_W,
            "height": RENDER_H,
            "imageDataUrl": encode_jpeg(cutout),
            "editMaskDataUrl": encode_png(cv2.cvtColor(edit_mask, cv2.COLOR_RGBA2BGRA)),
            "keepMaskDataUrl": encode_png(keep),
            "personMaskDataUrl": encode_png(person),
            "faceBox": identity["box"] if identity else None,
            # How many real pixels the face had in the camera frame, and how much the crop was enlarged:
            # a small, enlarged face looks soft next to a sharp render, so it is not pasted back.
            "faceSourcePx": round(face_width_px(analysis, width) or 0, 1),
            "upscale": round(RENDER_H / max(box[3], 1), 3),
            # Sharpest, largest close-up of the face seen this visit, used as the identity reference.
            "faceRefDataUrl": encode_jpeg(face_ref["image"]) if face_ref else None,
            "faceRefSourcePx": round(face_ref["facePx"], 1) if face_ref else None,
        },
        "faceEmbedding": identity["embedding"].round(6).tolist() if identity else None,
    })
