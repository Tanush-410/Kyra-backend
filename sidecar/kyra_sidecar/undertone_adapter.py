"""Adapter: the vendored undertone detector (vendor/undertone) driven by the sidecar's face mesh.

The detector measures depth (L*, ITA) and a continuous warm-to-cool position from CIELAB hue, per face
region, with flush compensation, outlier rejection, an uncertainty interval and a quality gate. Its
intended production input is MediaPipe Face Mesh regions; this module supplies them, white-balances
in linear light (grey-card calibration, else gray-world on the background), and combines the
per-frame results of a visit into one measurement.

Lighting is removed before anything is measured (see lighting.py): a grey card when calibrated, otherwise
the learned empty room, background statistics and the whites of the eyes, fused and smoothed over the visit.
Exposure is normalised too, so depth does not change with how bright the room is or how the camera exposed.
"""

from __future__ import annotations

from dataclasses import replace

import cv2
import numpy as np

from . import lighting
from .color import classify_depth
from .vendor.undertone.color import lab_to_srgb, linear_rgb_to_lab, linear_to_srgb, srgb_to_linear
from .vendor.undertone.detect import AnalysisConfig, Thresholds, analyze_srgb, failure_hints, ita_class, warm_cool_position
from .vendor.undertone.features import circular_mean_deg, circular_std_deg, skin_mask_srgb
from .vendor.undertone.palette import depth_from_ita, styling_recommendations
from .vendor.undertone.warmcool import WarmCoolCalibration

# Face-mesh landmark rings for the detector's sampling regions (clear of eyes, brows, nostrils, lips).
REGION_LANDMARKS = {
    "forehead": [109, 10, 338, 297, 332, 334, 296, 336, 9, 107, 66, 105, 103, 67],
    "left_cheek": [116, 117, 118, 100, 126, 142, 203, 206, 216, 207, 187, 147, 123],
    "right_cheek": [345, 346, 347, 329, 355, 371, 423, 426, 436, 427, 411, 376, 352],
    # Chin: below the lower lip's outer edge (181, 84, 17, 314, 405) down to the chin contour.
    "jaw": [181, 84, 17, 314, 405, 400, 377, 152, 148, 176],
}
FACE_TARGET_PX = 220      # face crops are resized so region sizes are comparable across distances
MIN_FACE_SOURCE_PX = 24   # below this the face has too little real detail to measure at all

THRESHOLDS = Thresholds(min_skin_pixels=250)
# Hair over the forehead and beard or moustache on the chin pass a colour-based skin mask, but are far
# darker than cheek skin under the same light. Pixels this far below the cheeks' L* are dropped.
MAX_DARKER_THAN_CHEEKS = 14.0
MIN_REGION_PIXELS = 40
# Lighting confidence below this means the light's colour was a guess (no card, no room model, eyes not seen).
LIGHTING_TRUSTED = 0.3
LIGHTING_HINT = ("The room's light could not be measured reliably, so colours may be off. Face the mirror with "
                 "your eyes open; for best results keep a grey card in view.")
# Shine: pixels this many L* above their region's median and with under this fraction of its chroma.
SHINE_BRIGHTER = 10.0
SHINE_CHROMA = 0.6


def make_config(warm_cool: dict | None, calibrated_white_balance: bool) -> AnalysisConfig:
    """Detector settings: fitted warm/cool anchors when available; 'ideal' tier only with a grey card."""
    config = AnalysisConfig(thresholds=THRESHOLDS, tier="ideal" if calibrated_white_balance else "minimum")
    if warm_cool:
        config = WarmCoolCalibration.from_dict(warm_cool).apply(config)
    return config


def _region_masks(points: np.ndarray, shape: tuple[int, int]) -> dict[str, np.ndarray]:
    masks = {}
    for name, indices in REGION_LANDMARKS.items():
        mask = np.zeros(shape, dtype=np.uint8)
        cv2.fillPoly(mask, [cv2.convexHull(points[indices].astype(np.int32))], 1)
        masks[name] = mask.astype(bool)
    return masks


def _skin_regions(regions: dict[str, np.ndarray], mask: np.ndarray, lab: np.ndarray) -> dict[str, np.ndarray]:
    """Region masks restricted to skin, without hair, beard and shine.

    Hair and beard are much darker than the cheeks. Shine (specular highlights) is much brighter than the rest of
    its region and nearly colourless: it is the light's colour reflected off the skin surface, not skin colour.
    """
    lightness = lab[..., 0]
    chroma = np.hypot(lab[..., 1], lab[..., 2])
    candidate = {name: region & mask for name, region in regions.items()}
    cheeks = [np.median(lightness[m]) for name, m in candidate.items() if "cheek" in name and m.sum() >= MIN_REGION_PIXELS]
    if cheeks:
        floor = max(cheeks) - MAX_DARKER_THAN_CHEEKS
        candidate = {name: m & (lightness >= floor) for name, m in candidate.items()}
    for name, m in candidate.items():
        if m.sum() >= MIN_REGION_PIXELS:
            shine = (lightness > np.median(lightness[m]) + SHINE_BRIGHTER) & (chroma < SHINE_CHROMA * np.median(chroma[m]))
            candidate[name] = m & ~shine
    return {name: m for name, m in candidate.items() if m.sum() >= MIN_REGION_PIXELS}


def measure_frame(rgb: np.ndarray, face_landmarks: np.ndarray | None, person_mask: np.ndarray | None,
                  reference_rgb: list[float] | None, config: AnalysisConfig, *,
                  people_mask: np.ndarray | None = None, room: lighting.RoomLight | None = None,
                  smoother: lighting.LightSmoother | None = None, card_baseline_rgb: list[float] | None = None,
                  card_lightness: float | None = None) -> dict | None:
    """One frame: remove the lighting, crop the face, sample mesh regions, run the detector. Compact result or None.

    rgb is the full-resolution frame. person_mask is the visitor's mask and people_mask every detected person's
    (both may be at analysis resolution); people are left out of the background light estimates. With a grey card
    (reference_rgb) the card decides the correction. Otherwise room (live camera only), the background and the
    whites of the eyes are fused, and smoother carries the estimate across a visit's frames.
    """
    if face_landmarks is None:
        return None
    h, w = rgb.shape[:2]
    points = face_landmarks * [w, h]
    x0, y0 = points.min(axis=0)
    x1, y1 = points.max(axis=0)
    face_px = float(x1 - x0)
    if face_px < MIN_FACE_SOURCE_PX:
        return None

    pad = 0.15 * face_px
    cx0, cy0 = int(max(0, x0 - pad)), int(max(0, y0 - pad))
    cx1, cy1 = int(min(w, x1 + pad)), int(min(h, y1 + pad))
    scale = FACE_TARGET_PX / max(face_px, 1.0)
    crop_srgb = cv2.resize(rgb[cy0:cy1, cx0:cx1], None, fx=scale, fy=scale,
                           interpolation=cv2.INTER_CUBIC if scale > 1 else cv2.INTER_AREA).astype(np.float64) / 255.0
    crop_raw = srgb_to_linear(np.clip(crop_srgb, 0, 1))
    crop_points = (points - [cx0, cy0]) * scale
    regions = _region_masks(crop_points, crop_raw.shape[:2])

    if reference_rgb is not None:
        correction = lighting.card_correction(reference_rgb, card_baseline_rgb, card_lightness)
        white_balance = "calibrated"
    else:
        exclude = people_mask if people_mask is not None else person_mask
        # A strided subsample, converted to linear before any averaging (averaging sRGB biases the estimate).
        step = max(1, w // 320)
        small = srgb_to_linear(rgb[::step, ::step].astype(np.float64) / 255.0)
        scene = lighting.scene_illuminant(small, exclude)
        room_light = room.relative(rgb, exclude) if room is not None else None
        sclera = None
        face_skin = np.logical_or.reduce(list(regions.values()))
        if face_skin.sum() >= MIN_REGION_PIXELS:
            skin = crop_raw[face_skin]
            sclera = lighting.sclera_illuminant(crop_raw, crop_points, lighting.to_uv(np.median(skin, axis=0)),
                                                float(np.median(skin @ lighting.LUMA)), scale)
        correction = lighting.auto_correction(scene, room_light, sclera)
        if room_light is not None and sclera is not None and sclera["confidence"] >= 0.3:
            # Each visitor's eyes teach the room model what its baseline light really is.
            room.learn(lighting.toward_locus(sclera["uv"], lighting.SCLERA_OFF_LOCUS_KEEP) - room_light["change"],
                       sclera["confidence"])
        if smoother is not None:
            correction = smoother.apply(correction)
        white_balance = "auto"

    crop_linear = np.clip(crop_raw * correction.gains * correction.exposure, 0, 1)
    crop = np.clip(linear_to_srgb(crop_linear), 0, 1)
    lab = linear_rgb_to_lab(crop_linear)

    def mask_provider(image):
        skin = skin_mask_srgb(image, restrict_to_largest=False)
        return skin & np.logical_or.reduce(list(regions.values()))

    def region_provider(mask):
        return _skin_regions(regions, mask, lab)

    # A per-call copy: the camera thread and still-photo requests share the base config.
    result = analyze_srgb(crop, None, replace(config, mask_provider=mask_provider, region_provider=region_provider))
    if result["measurement"] is None:
        return {"ok": False, "failures": result["quality"]["failures"], "facePx": face_px,
                "lighting": correction.report()}

    m, fusion = result["measurement"], result["quality"]["hue_fusion"]
    return {
        "ok": bool(result["ok"]),
        "lab": [m["L"], m["a"], m["b"]],
        "hue": float(fusion["hue"]) if fusion["n_regions"] else float(m["hue"]),
        "hueStd": float(fusion["hue_std"]) if fusion["n_regions"] else float("nan"),
        "regions": int(fusion["n_regions"]),
        "pixels": int(m["n_pixels"]),
        "confidence": float(result["confidence"]["score"]),
        "failures": result["quality"]["failures"],
        "flushing": bool((fusion.get("erythema") or {}).get("flushing_detected")),
        "makeupSuspected": bool((result["quality"].get("texture") or {}).get("makeup_suspected")),
        "whiteBalance": white_balance,
        "lighting": correction.report(),
        "facePx": face_px,
    }


def _lighting_confidence(frame: dict) -> float:
    return float((frame.get("lighting") or {}).get("confidence", 1.0))


def _lighting_summary(frames: list[dict]) -> dict | None:
    """What light was detected and removed over the visit."""
    reports = [f["lighting"] for f in frames if f.get("lighting")]
    if not reports:
        return None
    uv = np.median([r["castUV"] for r in reports], axis=0)
    methods = [r["method"] for r in reports]
    return {
        "method": max(set(methods), key=methods.count),
        "confidence": round(float(np.median([r["confidence"] for r in reports])), 3),
        "cast": lighting.describe_cast(uv),
        "castUV": [round(float(v), 4) for v in uv],
        "exposure": round(float(np.median([r["exposure"] for r in reports])), 3),
    }


def _swatch(L: float, a: float, b: float, position: dict) -> dict:
    """The visitor's measured skin colour and the detector's undertone statement (as in its _finalize)."""
    rgb = np.clip(np.round(lab_to_srgb(np.array([L, a, b])) * 255.0), 0, 255).astype(int)
    subtype = position.get("undertone_subtype")
    name = f"{(subtype or position['label']).replace('-', ' ').title()} Undertone"
    return {
        "skinHex": "#{:02X}{:02X}{:02X}".format(*rgb),
        "undertoneName": name,
        "statement": f"Your undertone is {position['label'].upper()} ({name})",
    }


def aggregate(frames: list[dict], config: AnalysisConfig) -> dict | None:
    """Combine a visit's per-frame results into one skin measurement (same shape the pipeline uses)."""
    measured = [f for f in frames if f and "lab" in f]
    if not measured:
        return None
    usable = [f for f in measured if f["ok"]] or measured
    # Prefer frames where the light was measured well (grey card, room model or eye whites in view).
    well_lit = [f for f in usable if _lighting_confidence(f) >= LIGHTING_TRUSTED]
    if len(well_lit) >= max(1, len(usable) // 3):
        usable = well_lit
    labs = np.array([f["lab"] for f in usable])
    L, a, b = np.median(labs, axis=0)
    hues = np.array([f["hue"] for f in usable])
    hue = circular_mean_deg(hues)
    # Uncertainty: spread across frames when there are several, else the spread across face regions.
    if len(usable) >= 3:
        hue_std = circular_std_deg(hues)
    else:
        within = [f["hueStd"] for f in usable if np.isfinite(f["hueStd"])]
        hue_std = float(np.mean(within)) if within else float("nan")
    n_regions = int(np.median([f["regions"] for f in usable]))
    position = warm_cool_position(hue, config, L=L, a=a, b=b, hue_std=hue_std if np.isfinite(hue_std) else None,
                                  n_regions=max(n_regions, len(usable)))
    ita = float(np.degrees(np.arctan((L - 50) / max(b, 1e-3))))

    ok_frames = sum(1 for f in measured if f["ok"])
    stable = position.get("stable")
    # high: repeated clean readings with a grey card and a label clear of the neutral band.
    # medium: usable, but the mirror should ask "looks right?". low: failed checks and on a boundary,
    # so the pipeline falls back to the neutral palette.
    if ok_frames >= 5 and stable is not False and config.tier == "ideal":
        confidence = "high"
    elif ok_frames >= 1 or stable is True:
        confidence = "medium"
    else:
        confidence = "low"
    failures = sorted({code for f in measured for code in f["failures"]}) if not ok_frames else []
    lighting_summary = _lighting_summary(usable)
    lighting_uncertain = bool(lighting_summary and lighting_summary["confidence"] < LIGHTING_TRUSTED)
    olive = bool(position.get("is_olive"))
    palette_key = "olive" if olive else position["label"]
    styling = styling_recommendations(palette_key, depth_from_ita(ita))

    return {
        "method": "undertone-detector",
        "lab": {"L": round(float(L), 1), "a": round(float(a), 1), "b": round(float(b), 1)},
        "ita": round(ita, 1),
        "hueAngle": round(float(position["hue"]), 1),
        "skinUndertone": position["label"],
        "skinSubtype": position.get("undertone_subtype"),
        "skinDepth": classify_depth(ita),
        "depthClass": ita_class(ita),
        "warmCool": {
            "score": round(float(position["score"]), 3),
            "ci95": [round(float(v), 3) for v in position["score_ci95"]] if "score_ci95" in position else None,
            "stable": stable,
            "olive": olive,
            "calibrated": bool(position.get("calibrated")),
        },
        **_swatch(float(L), float(a), float(b), position),
        "paletteKey": palette_key,
        "styling": {key: styling[key] for key in ("summary", "flattering_families", "best_metals", "avoid")},
        "whiteBalance": usable[0]["whiteBalance"],
        "lighting": lighting_summary,
        "framesUsed": len(usable),
        "framesPassed": ok_frames,
        "sampleCount": int(sum(f["pixels"] for f in usable)),
        "hueSpread": round(float(hue_std), 2) if np.isfinite(hue_std) else None,
        "confidence": confidence,
        "flushing": any(f["flushing"] for f in usable),
        "makeupSuspected": any(f["makeupSuspected"] for f in usable),
        "qualityFailures": failures,
        "hints": failure_hints(failures) + ([LIGHTING_HINT] if lighting_uncertain else []),
        "lightingUncertain": lighting_uncertain,
        "requireConfirmation": confidence != "high",
    }
