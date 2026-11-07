"""Colour science for skin-tone measurement. Mirrors backend/src/lib/image-analysis.js."""

import os

import numpy as np

# CIELAB hue-angle thresholds (degrees): redder skin reads cooler, yellower skin warmer. Defaults are
# heuristic; tune them from visitors' corrections with `npm run tune-thresholds` in backend/ and set
# SKIN_COOL_MAX_HUE / SKIN_WARM_MIN_HUE.
COOL_MAX_HUE = float(os.environ.get("SKIN_COOL_MAX_HUE") or 50.0)
WARM_MIN_HUE = float(os.environ.get("SKIN_WARM_MIN_HUE") or 58.0)


def srgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    """rgb: (..., 3) array in 0-255. Returns (..., 3) CIELAB (D65)."""
    c = np.clip(rgb.astype(np.float64) / 255.0, 0, 1)
    linear = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    r, g, b = linear[..., 0], linear[..., 1], linear[..., 2]
    x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
    y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883

    def f(t):
        return np.where(t > 0.008856, np.cbrt(t), 7.787 * t + 16 / 116)

    fx, fy, fz = f(x), f(y), f(z)
    return np.stack([116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)], axis=-1)


def skin_pixel_mask(rgb: np.ndarray) -> np.ndarray:
    """YCbCr skin-colour rule on white-balanced (..., 3) RGB."""
    r, g, b = rgb[..., 0].astype(np.float64), rgb[..., 1].astype(np.float64), rgb[..., 2].astype(np.float64)
    y = 0.299 * r + 0.587 * g + 0.114 * b
    cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b
    cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b
    return (y > 40) & (y < 240) & (cb >= 77) & (cb <= 127) & (cr >= 133) & (cr <= 173)


def gray_world_gains(rgb: np.ndarray, exclude: np.ndarray | None = None) -> np.ndarray:
    """Gains that make the (non-excluded, mid-tone) scene average neutral grey. Clamped to ±33%."""
    pixels = rgb.reshape(-1, 3).astype(np.float64)
    keep = np.ones(len(pixels), dtype=bool) if exclude is None else ~exclude.reshape(-1)
    luminance = pixels @ np.array([0.299, 0.587, 0.114])
    keep &= (luminance > 30) & (luminance < 230)
    if keep.sum() < 100:
        return np.ones(3)
    means = pixels[keep].mean(axis=0)
    return np.clip(means.mean() / np.maximum(means, 1e-6), 0.75, 1.33)


def gains_from_reference(rgb_patch: np.ndarray) -> np.ndarray:
    """Gains that turn a grey/white reference card patch neutral."""
    means = rgb_patch.reshape(-1, 3).astype(np.float64).mean(axis=0)
    return np.clip(means.mean() / np.maximum(means, 1e-6), 0.6, 1.6)


def describe_lab(lab: np.ndarray) -> dict:
    L, a, b = (float(v) for v in lab)
    ita = float(np.degrees(np.arctan((L - 50) / max(b, 1e-3))))
    hue = float(np.degrees(np.arctan2(b, a)))
    return {
        "lab": {"L": round(L, 1), "a": round(a, 1), "b": round(b, 1)},
        "ita": round(ita, 1),
        "hueAngle": round(hue, 1),
        "skinUndertone": classify_undertone(hue),
        "skinDepth": classify_depth(ita),
    }


def classify_undertone(hue_angle: float) -> str:
    if hue_angle <= COOL_MAX_HUE:
        return "cool"
    if hue_angle >= WARM_MIN_HUE:
        return "warm"
    return "neutral"


def classify_depth(ita: float) -> str:
    # Chardon/Del Bino ITA bands, merged into five groups.
    if ita > 55:
        return "fair"
    if ita > 41:
        return "light"
    if ita > 28:
        return "medium"
    if ita > 10:
        return "tan"
    return "deep"
