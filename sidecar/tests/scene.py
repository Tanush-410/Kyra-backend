"""Synthetic scenes for lighting tests: a face with known skin colour, eye whites and irises, in a room, under a
chosen light and camera exposure. Everything is built in linear reflectance, then "photographed"."""

import numpy as np

from kyra_sidecar.lighting import IRISES, LEFT_EYE, RIGHT_EYE
from kyra_sidecar.undertone_adapter import REGION_LANDMARKS
from kyra_sidecar.vendor.undertone.color import lab_to_linear_rgb, linear_to_srgb

H, W = 480, 640
FACE = (320, 200, 70, 90)        # centre x, centre y, half width, half height (pixels)
BODY = (220, 260, 420, 480)      # x0, y0, x1, y1 of the torso
SCLERA = np.array([0.62, 0.62, 0.62])
IRIS = np.array([0.06, 0.035, 0.02])
EYES = ((292, 182), (348, 182))  # centres; 22 x 8 px half-axes


def mondrian(rng, mean_tint=(1.0, 1.0, 1.0), tile=40) -> np.ndarray:
    """A wall of random coloured tiles whose average is exactly neutral (or tinted by mean_tint)."""
    tiles = rng.uniform(0.08, 0.6, (H // tile, W // tile, 3))
    tiles *= tiles.mean() / tiles.mean(axis=(0, 1))
    room = np.repeat(np.repeat(tiles, tile, axis=0), tile, axis=1)
    return np.clip(room * np.asarray(mean_tint), 0, 0.95)


def _ellipse(cx, cy, rx, ry) -> np.ndarray:
    yy, xx = np.mgrid[0:H, 0:W]
    return ((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2 <= 1


def _ring(cx, cy, rx, ry, n):
    # Mesh order: from one corner along the lower lid to the other corner, back along the upper lid.
    angles = np.pi - 2 * np.pi * np.arange(n) / n
    return np.column_stack([cx + rx * np.cos(angles), cy + ry * np.sin(angles)])


def visitor(room: np.ndarray, skin_lab, shirt=(0.55, 0.06, 0.05), eyes=True):
    """Adds a visitor to a room. Returns (reflectance, landmarks normalized (478, 2), person mask)."""
    scene = room.copy()
    person = np.zeros((H, W), np.float32)
    x0, y0, x1, y1 = BODY
    scene[y0:y1, x0:x1] = shirt
    person[y0:y1, x0:x1] = 1
    cx, cy, rx, ry = FACE
    face = _ellipse(cx, cy, rx, ry)
    scene[face] = np.clip(lab_to_linear_rgb(np.asarray(skin_lab, dtype=np.float64)), 0, 1)
    person[face] = 1

    rng = np.random.default_rng(1)
    points = np.column_stack([rng.uniform(cx - rx * 0.7, cx + rx * 0.7, 478), rng.uniform(cy - ry * 0.7, cy + ry * 0.7, 478)])
    points[0] = [cx - rx, cy]
    points[1] = [cx + rx, cy + ry]  # min/max of the mesh span the face
    points[2] = [cx, cy - ry]
    centres = {"forehead": (cx, cy - 55, 30, 12), "left_cheek": (cx - 38, cy + 18, 14, 14),
               "right_cheek": (cx + 38, cy + 18, 14, 14), "jaw": (cx, cy + 68, 16, 8)}
    for name, indices in REGION_LANDMARKS.items():
        points[indices] = _ring(*centres[name], len(indices))
    for contour, (ex, ey) in zip((LEFT_EYE, RIGHT_EYE), EYES):
        points[contour] = _ring(ex, ey, 22, 8, len(contour))
        if eyes:
            scene[_ellipse(ex, ey, 22, 8)] = SCLERA
            scene[_ellipse(ex, ey, 7, 7)] = IRIS
    for (centre, ring), (ex, ey) in zip(IRISES, EYES):
        points[centre] = [ex, ey]
        points[list(ring)] = _ring(ex, ey, 7, 7, 4)
    return scene, points / [W, H], person


def photograph(reflectance: np.ndarray, light=(1.0, 1.0, 1.0), exposure: float = 1.0, seed: int = 0) -> np.ndarray:
    """sRGB uint8 photo of a reflectance image under a light colour (per-channel) and exposure, with sensor noise."""
    linear = reflectance * np.asarray(light) * exposure
    rgb = linear_to_srgb(np.clip(linear, 0, 1)) * 255
    rng = np.random.default_rng(seed)
    return np.clip(rgb + rng.normal(0, 1.0, rgb.shape), 0, 255).astype(np.uint8)
