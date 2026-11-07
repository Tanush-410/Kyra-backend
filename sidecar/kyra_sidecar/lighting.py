"""Lighting compensation: work out the light falling on the visitor and remove it before skin is measured.

A camera records skin reflectance multiplied by the colour and strength of the light, after the camera's own
auto white balance and auto exposure have had their say. Under warm bulbs everyone reads warm, under cool LEDs
everyone reads cool, and a visitor in dark clothes makes the camera brighten the whole frame, so their skin
reads lighter than it is. Undertone (hue) depends on the light's colour; depth (L*, ITA) on its strength.

The light is described by its log-chromaticity (u, v) = (ln R/G, ln B/G) in linear sRGB. A von Kries correction
divides it out, so (u, v) cues from different sources can be averaged. Cues, most trusted first:

1. Grey card (calibration): measured live in every frame. Ground truth when present.
2. Room model: the camera is fixed, so the empty room is its own reference. While nobody is in frame the room is
   learned (a small linear image plus the light estimated from it). While a visitor is in frame, the background
   pixels around them are compared with that reference: the per-channel ratio is exactly how much the light and
   the camera's white balance and exposure have changed since, whatever colour the walls are. This also catches
   the camera re-exposing for the visitor's clothes, so depth stays stable. The room's own light (the baseline
   the changes are added to) is estimated from the empty room and, as visitors come and go, from their eyes, so
   a beige or coloured wall stops biasing it after a few visits.
3. Scene statistics on the background with every person excluded: gray-world, shades-of-gray (p=6), gray-edge
   and the brightest pixels, combined by median so one fooled estimator cannot decide alone.
4. Sclera: the whites of the eyes are nearly neutral and sit in exactly the light that falls on the skin, so they
   catch light the background does not see (a coloured lamp next to the mirror). Weighted lightly, because real
   sclera is not perfectly white.

Statistical estimates are pulled toward the Planckian (black-body) locus, since real lights (daylight, bulbs,
LEDs) lie close to it while a coloured wall usually does not. Live frames are smoothed over time because room
light changes slowly and per-frame estimates are noisy.

Hue in CIELAB is unchanged by plain brightness changes (a* and b* scale together), so shading across the face
does not move the undertone; only the light's colour does, and that is what this module removes.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

from .vendor.undertone.color import srgb_to_linear

LUMA = np.array([0.2126, 0.7152, 0.0722])
MAX_CAST = float(np.log(2.0))           # largest per-channel correction (×2 or ÷2) ever applied
EXPOSURE_RANGE = (0.6, 1.6)             # largest exposure correction from the room model
CARD_EXPOSURE_RANGE = (0.5, 2.0)
THUMB_WIDTH = 160                       # room-model resolution
CLIPPED = 0.95                          # linear value above which a channel is treated as clipped

# Cue weights when fused. A statistical cue this far (in uv) from the eye whites has lost most of its weight.
SCENE_WEIGHT, SCLERA_WEIGHT, OUTLIER_SCALE = 0.15, 1.0, 0.12
# Cameras already auto white balance, so the colour left on the background is mostly the walls' own colour,
# not the light's. The background estimate is therefore weighted low and applied at half strength. Measured on
# the benchmark (scripts/undertone_benchmark.py, camera white balance and yellow-walled rooms included): eyes
# closed against a beige wall went from 20 to 32 of 36 right, a yellow room from 28 to 32, nothing got worse.
SCENE_STRENGTH = 0.5
# Room baseline learned from visitors' eyes: weight grows with evidence (about three visits to reach 1).
LEARNED_WEIGHT_PER_UNIT, LEARNED_MAX_WEIGHT, LEARNED_MEMORY = 1 / 60, 2.0, 300.0
# Average colour of real sclera relative to white, in (u, v). Zero assumes white; measure it once with a grey card
# in view (sclera cue minus card) to remove the slight yellow of most people's eye whites.
SCLERA_UV_OFFSET = np.zeros(2)
# How much of an estimate's distance from the light locus is kept (the rest is treated as scene colour).
SCENE_OFF_LOCUS_KEEP, SCLERA_OFF_LOCUS_KEEP = 0.5, 1.0

# Face-mesh eye contours, lid points and iris landmarks (the 478-point mesh includes the irises).
LEFT_EYE = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246]
RIGHT_EYE = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398]
EYE_LIDS = ((159, 145, 33, 133), (386, 374, 362, 263))  # upper lid, lower lid, corner, corner
IRISES = ((468, (469, 470, 471, 472)), (473, (474, 475, 476, 477)))
MIN_SCLERA_SOURCE_PX = 8     # real camera pixels per eye; fewer is noise
MIN_EYE_OPENNESS = 0.18      # lid gap / eye width; below this the eye is closed or squinting
SCLERA_LESS_RED_THAN_SKIN = 0.12  # ln(R/G) margin. Casts shift skin and sclera equally, so this is light-invariant.

_XYZ_TO_LINEAR_SRGB = np.array([[3.2404542, -1.5371385, -0.4985314],
                                [-0.9692660, 1.8760108, 0.0415560],
                                [0.0556434, -0.2040259, 1.0572252]])


# ---- log-chromaticity -------------------------------------------------------------------------

def to_uv(rgb) -> np.ndarray:
    """(…, 3) linear RGB → (…, 2) log-chromaticity (ln R/G, ln B/G). Neutral is (0, 0)."""
    rgb = np.maximum(np.asarray(rgb, dtype=np.float64), 1e-6)
    return np.stack([np.log(rgb[..., 0] / rgb[..., 1]), np.log(rgb[..., 2] / rgb[..., 1])], axis=-1)


def gains_for(uv) -> np.ndarray:
    """Per-channel gains that turn light of chromaticity uv neutral without changing a grey's luminance."""
    light = np.array([np.exp(uv[0]), 1.0, np.exp(uv[1])])
    return float(light @ LUMA) / light


def describe_cast(uv) -> str:
    """Plain-language name of a detected light colour, e.g. "warm (yellow-orange) light, green tint"."""
    u, v = float(uv[0]), float(uv[1])
    warmth, green = (u - v) / 2, -(u + v) / 2
    parts = []
    if warmth > 0.03:
        parts.append("warm (yellow-orange) light")
    elif warmth < -0.03:
        parts.append("cool (blue) light")
    if green > 0.03:
        parts.append("green tint")
    elif green < -0.03:
        parts.append("magenta tint")
    return ", ".join(parts) or "neutral light"


# ---- the light locus --------------------------------------------------------------------------

def _planck_xy(kelvin: float) -> tuple[float, float]:
    """CIE 1931 xy of a black body (Kim et al. 2002 cubic approximation, 1667–25000 K)."""
    t = float(kelvin)
    if t <= 4000:
        x = -0.2661239e9 / t**3 - 0.2343589e6 / t**2 + 0.8776956e3 / t + 0.179910
    else:
        x = -3.0258469e9 / t**3 + 2.1070379e6 / t**2 + 0.2226347e3 / t + 0.240390
    if t <= 2222:
        y = -1.1063814 * x**3 - 1.34811020 * x**2 + 2.18555832 * x - 0.20219683
    elif t <= 4000:
        y = -0.9549476 * x**3 - 1.37418593 * x**2 + 2.09137015 * x - 0.16748867
    else:
        y = 3.0817580 * x**3 - 5.87338670 * x**2 + 3.75112997 * x - 0.37001483
    return x, y


def _light_locus() -> np.ndarray:
    """Black-body chromaticities (2500–15000 K) in (u, v), shifted to pass through neutral: the camera has already
    white-balanced toward roughly daylight, so what is left is a residual along this curve."""
    points = []
    for kelvin in np.geomspace(2500, 15000, 400):
        x, y = _planck_xy(kelvin)
        rgb = _XYZ_TO_LINEAR_SRGB @ np.array([x / y, 1.0, (1 - x - y) / y])
        points.append(to_uv(np.maximum(rgb, 1e-4)))
    points = np.array(points)
    return points - points[np.argmin(np.linalg.norm(points, axis=1))]


LOCUS = _light_locus()


def toward_locus(uv, keep: float = SCENE_OFF_LOCUS_KEEP) -> np.ndarray:
    """Pulls a light estimate toward the nearest real light colour, keeping `keep` of the distance from it.

    A green or purple "light" is far more often a green or purple wall; real lights (with some green/magenta
    for fluorescent tubes and cheap LEDs) lie near the black-body locus."""
    uv = np.asarray(uv, dtype=np.float64)
    nearest = LOCUS[np.argmin(np.linalg.norm(LOCUS - uv, axis=1))]
    return nearest + keep * (uv - nearest)


def _clamp_uv(uv) -> np.ndarray:
    return np.clip(np.asarray(uv, dtype=np.float64), -MAX_CAST, MAX_CAST)


# ---- cue: scene statistics --------------------------------------------------------------------

def _background(shape: tuple[int, int], exclude: np.ndarray | None) -> np.ndarray:
    """Pixels clear of every person, with a margin so hair and clothing edges are not counted."""
    if exclude is None:
        return np.ones(shape, dtype=bool)
    exclude = np.asarray(exclude)
    if exclude.shape != shape:
        exclude = cv2.resize(exclude.astype(np.float32), (shape[1], shape[0]), interpolation=cv2.INTER_NEAREST)
    grow = max(3, shape[1] // 40) | 1
    return cv2.dilate((exclude > 0.5).astype(np.uint8), np.ones((grow, grow), np.uint8)) == 0


def scene_illuminant(linear: np.ndarray, exclude: np.ndarray | None = None) -> dict | None:
    """Light colour from the background of a linear frame (people excluded). None when too little is visible.

    Four classic estimators are combined by median; their agreement and the variety of colours in view
    set the confidence (one big coloured wall cannot be told apart from coloured light)."""
    h, w = linear.shape[:2]
    luminance = linear @ LUMA
    valid = (_background((h, w), exclude) & (luminance > 0.01)
             & (linear.max(axis=-1) < CLIPPED) & (linear.min(axis=-1) > 1e-4))
    count = int(valid.sum())
    if count < 300:
        return None
    pixels = linear[valid].astype(np.float64)
    estimates = {
        "grayWorld": pixels.mean(axis=0),
        "shadesOfGray": np.mean(pixels ** 6, axis=0) ** (1 / 6),
    }
    lum = luminance[valid]
    brightest = pixels[lum >= np.percentile(lum, 97)]
    if len(brightest) >= 20:
        estimates["brightPixels"] = brightest.mean(axis=0)
    blurred = cv2.GaussianBlur(linear.astype(np.float32), (0, 0), 1.0)
    gradient = np.sqrt(cv2.Sobel(blurred, cv2.CV_32F, 1, 0, ksize=3) ** 2
                       + cv2.Sobel(blurred, cv2.CV_32F, 0, 1, ksize=3) ** 2)
    inner = cv2.erode(valid.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
    edges = gradient[inner].astype(np.float64)
    if len(edges) >= 200 and edges.mean() > 1e-4:
        estimates["grayEdge"] = np.mean(edges ** 6, axis=0) ** (1 / 6)

    uvs = np.array([to_uv(e) for e in estimates.values()])
    uv = np.median(uvs, axis=0)
    spread = float(np.median(np.linalg.norm(uvs - uv, axis=1)))
    variety = float(np.mean(np.std(to_uv(pixels), axis=0)))
    confidence = (np.exp(-(spread / 0.08) ** 2) * min(1.0, count / 3000) * min(1.0, variety / 0.12))
    return {
        "uv": _clamp_uv(toward_locus(uv) * SCENE_STRENGTH),
        "confidence": float(confidence),
        "cues": {name: np.round(to_uv(e), 3).tolist() for name, e in estimates.items()},
    }


# ---- cue: sclera ------------------------------------------------------------------------------

def sclera_illuminant(linear: np.ndarray, points: np.ndarray, skin_uv: np.ndarray, skin_y: float,
                      source_scale: float = 1.0) -> dict | None:
    """Light colour at the face, from the whites of the eyes.

    linear: face crop in linear RGB (before any correction). points: (478, 2) face mesh in crop pixels.
    skin_uv / skin_y: chromaticity and luminance of the cheeks in the same crop, for the sanity checks.
    source_scale: how much the crop was enlarged from the camera frame (to count real pixels)."""
    if points is None or len(points) < 478:
        return None
    h, w = linear.shape[:2]
    found = []
    for contour, (upper, lower, corner_a, corner_b) in zip((LEFT_EYE, RIGHT_EYE), EYE_LIDS):
        width = float(np.linalg.norm(points[corner_a] - points[corner_b]))
        if width < 6 or np.linalg.norm(points[upper] - points[lower]) / width < MIN_EYE_OPENNESS:
            continue
        mask = np.zeros((h, w), dtype=np.uint8)
        cv2.fillPoly(mask, [np.round(points[contour]).astype(np.int32)], 1)
        k = max(1, int(round(width * 0.04)))
        mask = cv2.erode(mask, np.ones((2 * k + 1, 2 * k + 1), np.uint8))  # off the lids and lashes
        centre = points[contour].mean(axis=0)
        iris_centre, ring = min(IRISES, key=lambda iris: np.linalg.norm(points[iris[0]] - centre))
        radius = float(np.mean(np.linalg.norm(points[list(ring)] - points[iris_centre], axis=1)))
        cx, cy = np.round(points[iris_centre]).astype(int)
        cv2.circle(mask, (int(cx), int(cy)), int(radius * 1.15 + 1), 0, -1)
        pixels = linear[mask.astype(bool)].astype(np.float64)
        pixels = pixels[(pixels.max(axis=-1) < CLIPPED) & (pixels.min(axis=-1) > 1e-4)]
        if len(pixels) / max(source_scale, 1.0) ** 2 < MIN_SCLERA_SOURCE_PX:
            continue
        y = pixels @ LUMA
        whitest = pixels[y >= np.median(y)]  # drops lash shadow and the vessels at the corners
        light = np.median(whitest, axis=0)
        uv = to_uv(light)
        # Checks that do not depend on the light: sclera is brighter than skin and much less red.
        if float(light @ LUMA) < 0.8 * skin_y or skin_uv[0] - uv[0] < SCLERA_LESS_RED_THAN_SKIN:
            continue
        found.append((uv - SCLERA_UV_OFFSET, len(whitest) / max(source_scale, 1.0) ** 2))
    if not found:
        return None
    uvs = np.array([uv for uv, _ in found])
    weights = np.array([n for _, n in found])
    uv = (uvs * weights[:, None]).sum(axis=0) / weights.sum()
    disagreement = float(np.linalg.norm(uvs[0] - uvs[1])) if len(found) == 2 else 0.05
    confidence = min(1.0, weights.sum() / 60) * np.exp(-(disagreement / 0.1) ** 2) * (1.0 if len(found) == 2 else 0.7)
    return {"uv": _clamp_uv(uv), "confidence": float(confidence), "eyes": len(found)}


# ---- cue: the room model ----------------------------------------------------------------------

def thumbnail(rgb: np.ndarray, shape: tuple[int, int] | None = None) -> np.ndarray:
    """Small linear-light copy of an sRGB uint8 frame (area-averaged in linear light, which is unbiased)."""
    step = max(1, rgb.shape[1] // (THUMB_WIDTH * 2))
    linear = srgb_to_linear(rgb[::step, ::step].astype(np.float64) / 255.0).astype(np.float32)
    if shape is None:
        shape = (max(1, round(THUMB_WIDTH * rgb.shape[0] / rgb.shape[1])), THUMB_WIDTH)
    return cv2.resize(linear, (shape[1], shape[0]), interpolation=cv2.INTER_AREA)


class RoomLight:
    """Learns the empty room so that light and camera changes can be measured while a visitor is in frame.

    Used from the camera thread only. `observe` every frame; `relative` when measuring a visitor."""

    def __init__(self, settle_frames: int = 8, relearn_frames: int = 150, min_updates: int = 5):
        self.settle_frames = settle_frames      # empty frames in a row before learning (someone may be half in view)
        self.relearn_frames = relearn_frames    # frames of a rearranged room before it is learned afresh
        self.min_updates = min_updates
        self.reference: np.ndarray | None = None
        self.base_uv: np.ndarray | None = None  # light colour of the reference, from scene statistics
        self.base_confidence = 0.0
        self.learned_uv: np.ndarray | None = None  # light colour of the reference, from visitors' eyes
        self.learned_weight = 0.0
        self.updates = 0
        self._empty_streak = 0
        self._changed_streak = 0

    @property
    def ready(self) -> bool:
        return self.reference is not None and self.base_uv is not None and self.updates >= self.min_updates

    def reset(self) -> None:
        self.reference, self.base_uv, self.base_confidence, self.updates = None, None, 0.0, 0
        self.learned_uv, self.learned_weight = None, 0.0
        self._empty_streak = self._changed_streak = 0

    def baseline(self) -> tuple[np.ndarray, float]:
        """The reference's light colour and how much to trust it: the empty-room statistics fused with what
        visitors' eyes have shown."""
        cues = [(self.base_uv, SCENE_WEIGHT * max(self.base_confidence, 0.05))]
        if self.learned_uv is not None:
            cues.append((self.learned_uv, min(LEARNED_MAX_WEIGHT, self.learned_weight * LEARNED_WEIGHT_PER_UNIT)))
        weights = np.array([w for _, w in cues])
        uv = (np.array([uv for uv, _ in cues]) * weights[:, None]).sum(axis=0) / weights.sum()
        return uv, float(weights.sum())

    def learn(self, reference_uv: np.ndarray, confidence: float) -> None:
        """Adds a visitor's eye-white reading, already moved into the reference's frame (light now minus change)."""
        if confidence <= 0 or not self.ready:
            return
        if self.learned_uv is None:
            self.learned_uv, self.learned_weight = np.asarray(reference_uv, dtype=np.float64).copy(), confidence
            return
        total = min(self.learned_weight + confidence, LEARNED_MEMORY)  # capped, so it keeps adapting
        self.learned_uv = self.learned_uv + (confidence / total) * (np.asarray(reference_uv) - self.learned_uv)
        self.learned_weight = total

    def observe(self, rgb: np.ndarray, present: bool) -> None:
        if present:
            self._empty_streak = 0
            return
        self._empty_streak += 1
        if self._empty_streak < self.settle_frames:
            return
        thumb = thumbnail(rgb, self.reference.shape[:2] if self.reference is not None else None)
        shift = np.zeros(2)
        if self.reference is not None:
            # A global light change is fine (that is what the model measures); a rearranged room is not.
            ratio = np.log(np.maximum(thumb @ LUMA, 1e-4)) - np.log(np.maximum(self.reference @ LUMA, 1e-4))
            rearranged = float(np.mean(np.abs(ratio - np.median(ratio)) > 0.2))
            shift = np.median(to_uv(np.maximum(thumb, 1e-4)) - to_uv(np.maximum(self.reference, 1e-4)), axis=(0, 1))
            if rearranged > 0.25:
                self._changed_streak += 1
                if self._changed_streak < self.relearn_frames:
                    return
                self.reset()
                self._empty_streak = self.settle_frames
            else:
                self._changed_streak = 0
        alpha = 1.0 if self.reference is None else max(0.05, 1.0 / (self.updates + 1))
        self.reference = thumb if self.reference is None else (1 - alpha) * self.reference + alpha * thumb
        if self.learned_uv is not None:
            self.learned_uv = self.learned_uv + alpha * shift  # the reference's light moved; so does what was learned
        self.updates += 1
        if self.updates <= self.min_updates or self.updates % 5 == 0:
            scene = scene_illuminant(self.reference)
            if scene is not None:
                self.base_uv, self.base_confidence = scene["uv"], scene["confidence"]

    def relative(self, rgb: np.ndarray, exclude: np.ndarray | None = None) -> dict | None:
        """Light now, from how the visible background changed since the empty room was learned."""
        if not self.ready:
            return None
        thumb = thumbnail(rgb, self.reference.shape[:2])
        valid = _background(thumb.shape[:2], exclude)
        for image in (thumb, self.reference):
            valid &= (image @ LUMA > 0.02) & (image.max(axis=-1) < CLIPPED) & (image.min(axis=-1) > 1e-4)
        coverage = float(valid.mean())
        if coverage < 0.12:
            return None
        log_ratio = np.log(thumb[valid].astype(np.float64)) - np.log(self.reference[valid].astype(np.float64))
        chroma = np.stack([log_ratio[:, 0] - log_ratio[:, 1], log_ratio[:, 2] - log_ratio[:, 1]], axis=1)
        delta = np.median(chroma, axis=0)
        chroma_spread = float(np.median(np.linalg.norm(chroma - delta, axis=1)))
        luma_ratio = log_ratio @ LUMA
        exposure_change = float(np.median(luma_ratio))
        luma_spread = float(np.median(np.abs(luma_ratio - exposure_change)))
        confidence = (np.exp(-(chroma_spread / 0.05) ** 2) * min(1.0, coverage / 0.3)
                      * (1.0 if luma_spread < 0.15 else 0.5))
        base, base_weight = self.baseline()
        return {
            "base": base,
            "baseWeight": base_weight,
            "change": delta,
            "exposure": float(np.clip(np.exp(-exposure_change), *EXPOSURE_RANGE)),
            "confidence": float(confidence),
            "coverage": round(coverage, 3),
        }


# ---- fusion -----------------------------------------------------------------------------------

@dataclass
class Correction:
    gains: np.ndarray
    exposure: float
    uv: np.ndarray
    method: str
    confidence: float
    cues: dict = field(default_factory=dict)

    def report(self) -> dict:
        return {
            "method": self.method,
            "confidence": round(float(self.confidence), 3),
            "cast": describe_cast(self.uv),
            "castUV": [round(float(v), 4) for v in self.uv],
            "exposure": round(float(self.exposure), 3),
            "cues": self.cues,
        }


def card_correction(reference_rgb, baseline_rgb=None, card_lightness: float | None = None) -> Correction:
    """Grey card: its colour is the light's colour. Exposure is normalised to the card's known lightness when
    given, otherwise to its brightness when calibrated, so depth does not drift with the room's light level."""
    card = srgb_to_linear(np.asarray(reference_rgb, dtype=np.float64) / 255.0)
    uv = _clamp_uv(to_uv(card))
    card_y = max(float(card @ LUMA), 1e-4)
    exposure = 1.0
    if card_lightness:
        exposure = ((float(card_lightness) + 16) / 116) ** 3 / card_y
    elif baseline_rgb is not None:
        exposure = float(srgb_to_linear(np.asarray(baseline_rgb, dtype=np.float64) / 255.0) @ LUMA) / card_y
    exposure = float(np.clip(exposure, *CARD_EXPOSURE_RANGE))
    return Correction(gains_for(uv), exposure, uv, "grey-card", 1.0, {"card": np.round(uv, 3).tolist()})


def _fuse(cues: list[tuple[str, np.ndarray, float]], anchor: str | None = None) -> tuple[np.ndarray, dict, float]:
    """Weighted mean of (name, uv, weight) cues. Cues far from the anchor (the eye whites: a direct measurement at
    the face) lose weight, since a statistical estimate that disagrees with it was most likely fooled by a
    coloured wall. Returns the fused uv, a report and the total effective weight."""
    anchor_uv = next((uv for name, uv, _ in cues if name == anchor), None)
    fused = []
    for name, uv, weight in cues:
        if anchor_uv is not None and name != anchor:
            weight *= max(0.05, float(np.exp(-(np.linalg.norm(uv - anchor_uv) / OUTLIER_SCALE) ** 2)))
        fused.append((name, uv, weight))
    weights = np.array([w for _, _, w in fused])
    uv = (np.array([uv for _, uv, _ in fused]) * weights[:, None]).sum(axis=0) / weights.sum()
    report = {name: {"uv": np.round(uv_i, 3).tolist(), "weight": round(float(w), 3)} for name, uv_i, w in fused}
    return uv, report, float(weights.sum())


def auto_correction(scene: dict | None, room: dict | None, sclera: dict | None) -> Correction:
    """Fuses the available cues into one correction.

    With the room model: light now = the room's baseline + the measured change since. The visitor's eye whites
    (moved back by the change) refine the baseline. Without it: background statistics and eye whites."""
    sclera_uv = toward_locus(sclera["uv"], SCLERA_OFF_LOCUS_KEEP) if sclera and sclera["confidence"] > 0.05 else None
    sclera_weight = SCLERA_WEIGHT * sclera["confidence"] if sclera_uv is not None else 0.0
    if room and room["confidence"] > 0.05:
        change = np.asarray(room["change"])
        cues = [("room", np.asarray(room["base"]), room["baseWeight"])]
        if sclera_uv is not None:
            cues.append(("sclera", sclera_uv - change, sclera_weight))
        base, report, weight = _fuse(cues, anchor="sclera")
        report["room"].update({"change": np.round(change, 3).tolist(), "coverage": room["coverage"]})
        uv = _clamp_uv(base + change)
        exposure = room["exposure"] if room["confidence"] >= 0.3 else 1.0
        confidence = room["confidence"] * min(1.0, weight / 1.5)
        return Correction(gains_for(uv), exposure, uv, "+".join(name for name, _, _ in cues), confidence, report)

    cues = []
    if scene and scene["confidence"] > 0.05:
        cues.append(("scene", np.asarray(scene["uv"]), SCENE_WEIGHT * scene["confidence"]))
    if sclera_uv is not None:
        cues.append(("sclera", sclera_uv, sclera_weight))
    if not cues:
        return Correction(np.ones(3), 1.0, np.zeros(2), "none", 0.0, {})
    uv, report, weight = _fuse(cues, anchor="sclera")
    return Correction(gains_for(_clamp_uv(uv)), 1.0, _clamp_uv(uv), "+".join(name for name, _, _ in cues),
                      min(1.0, weight / 1.5), report)


class LightSmoother:
    """Smooths the correction over a visit's frames: room light changes slowly, per-frame estimates are noisy."""

    def __init__(self, alpha: float = 0.3):
        self.alpha = alpha
        self.uv: np.ndarray | None = None
        self.log_exposure = 0.0

    def reset(self) -> None:
        self.uv = None

    def apply(self, correction: Correction) -> Correction:
        if correction.confidence <= 0:
            return correction
        if self.uv is None:
            self.uv, self.log_exposure = correction.uv.copy(), float(np.log(correction.exposure))
        else:
            a = self.alpha * min(1.0, 0.3 + correction.confidence)
            self.uv = (1 - a) * self.uv + a * correction.uv
            self.log_exposure = (1 - a) * self.log_exposure + a * float(np.log(correction.exposure))
        exposure = float(np.exp(self.log_exposure))
        return Correction(gains_for(self.uv), exposure, self.uv.copy(), correction.method, correction.confidence,
                          correction.cues)
