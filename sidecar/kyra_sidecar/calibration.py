"""Per-installation calibration, persisted to calibration.json.

Height: the camera is fixed, so a person's height in the frame depends only on how far they stand.
Standing further back moves their feet up the frame, so we fit centimetres-per-frame-height as a
linear function of foot position from one or more reference people of known height.

White balance: a matte neutral card stays visible in a fixed camera region. Its colour is measured
in every frame so the correction follows changes in the room lighting.
"""

import json
import threading
import time
from pathlib import Path

import numpy as np

from .color import gains_from_reference

MAX_HEIGHT_SAMPLES = 12


class Calibration:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()
        self.height_samples: list[dict] = []
        self.white_balance: dict | None = None
        self.white_balance_roi: dict | None = None
        # Warm/cool anchors fitted by the undertone detector from visitors' confirmed undertones.
        self.warm_cool: dict | None = None
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            data = json.loads(self.path.read_text())
        except (OSError, json.JSONDecodeError):
            return
        self.height_samples = list(data.get("heightSamples", []))[-MAX_HEIGHT_SAMPLES:]
        self.white_balance = data.get("whiteBalance")
        self.white_balance_roi = (self.white_balance or {}).get("roi")
        self.warm_cool = data.get("warmCool")

    def _save(self) -> None:
        self.path.write_text(json.dumps(
            {"heightSamples": self.height_samples, "whiteBalance": self.white_balance, "warmCool": self.warm_cool}, indent=2))

    def add_height_sample(self, foot_y: float, pixel_height: float, height_cm: float) -> dict:
        with self._lock:
            self.height_samples.append(
                {"footY": round(foot_y, 4), "pixelHeight": round(pixel_height, 4), "heightCm": height_cm, "at": time.time()}
            )
            self.height_samples = self.height_samples[-MAX_HEIGHT_SAMPLES:]
            self._save()
            return self.summary()

    def set_white_balance(self, gains: np.ndarray, reference_rgb: list[float], roi: dict | None = None,
                          card_lightness: float | None = None) -> dict:
        """card_lightness: the card's printed L* (about 50 for an 18% grey card), if known. With it, skin depth is
        measured in absolute terms; without it, relative to the room's brightness at calibration time."""
        with self._lock:
            self.white_balance = {
                "gains": [round(float(g), 4) for g in gains],
                "referenceRgb": [round(float(v), 1) for v in reference_rgb],
                "roi": roi,
                "cardLightness": card_lightness,
                "at": time.time(),
            }
            self.white_balance_roi = roi
            self._save()
            return self.summary()

    def set_warm_cool(self, fitted: dict | None) -> dict:
        with self._lock:
            self.warm_cool = fitted
            self._save()
            return self.summary()

    def reference_rgb(self, rgb: np.ndarray | None = None) -> list[float] | None:
        """Current card colour when a frame is supplied; saved calibration otherwise."""
        if rgb is not None and self.white_balance_roi:
            h, w = rgb.shape[:2]
            roi = self.white_balance_roi
            x0, y0 = int(roi["x"] * w), int(roi["y"] * h)
            x1, y1 = int((roi["x"] + roi["width"]) * w), int((roi["y"] + roi["height"]) * h)
            patch = rgb[max(0, y0):min(h, y1), max(0, x0):min(w, x1)]
            if patch.size < 300:
                return None
            pixels = patch.reshape(-1, 3).astype(np.float64)
            luminance = pixels @ np.array([0.2126, 0.7152, 0.0722])
            pixels = pixels[(luminance > 35) & (luminance < 250)]
            if len(pixels) < 100:
                return None
            reference = np.median(pixels, axis=0)
            if reference.min() < 35 or reference.max() > 250:
                return None
            return reference.tolist()
        return list(self.white_balance["referenceRgb"]) if self.white_balance else None

    def card_settings(self) -> dict:
        """Grey-card exposure settings for undertone_adapter.measure_frame (empty without a card)."""
        if not self.white_balance:
            return {}
        return {"card_baseline_rgb": self.white_balance.get("referenceRgb"),
                "card_lightness": self.white_balance.get("cardLightness")}

    def reset(self) -> dict:
        with self._lock:
            self.height_samples = []
            self.white_balance = None
            self.white_balance_roi = None
            self.warm_cool = None
            self._save()
            return self.summary()

    def white_balance_gains(self, rgb: np.ndarray | None = None) -> np.ndarray | None:
        """Live gains from the card in rgb; the saved calibration gains without a frame."""
        if not self.white_balance:
            return None
        if rgb is None and self.white_balance.get("gains"):
            return np.asarray(self.white_balance["gains"], dtype=np.float64)
        reference = self.reference_rgb(rgb)
        if reference is None:
            return None
        return gains_from_reference(np.asarray(reference, dtype=np.float64).reshape(1, 3))

    def height_model(self) -> tuple[float, float] | None:
        """(a, b) such that cm_per_frame_height = a + b * foot_y, or None if uncalibrated."""
        if not self.height_samples:
            return None
        foot = np.array([s["footY"] for s in self.height_samples])
        scale = np.array([s["heightCm"] / s["pixelHeight"] for s in self.height_samples])
        if len(self.height_samples) == 1 or np.ptp(foot) < 0.02:
            return float(scale.mean()), 0.0
        b, a = np.polyfit(foot, scale, 1)
        return float(a), float(b)

    def estimate_height_cm(self, foot_y: float, pixel_height: float) -> float | None:
        model = self.height_model()
        if model is None or pixel_height <= 0:
            return None
        a, b = model
        return round((a + b * foot_y) * pixel_height, 1)

    def summary(self) -> dict:
        model = self.height_model()
        return {
            "height": {
                "calibrated": model is not None,
                "samples": len(self.height_samples),
                "model": {"a": round(model[0], 3), "b": round(model[1], 3)} if model else None,
            },
            "whiteBalance": {"calibrated": self.white_balance is not None, **(self.white_balance or {})},
            "warmCool": {"calibrated": self.warm_cool is not None, **(self.warm_cool or {})},
        }
