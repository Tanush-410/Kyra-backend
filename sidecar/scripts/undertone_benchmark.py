"""Undertone confidence benchmark: many synthetic people, many lighting conditions, through the real pipeline.

Each test is one visit: 8 camera frames of one person in one condition, measured by
undertone_adapter.measure_frame (lighting compensation + vendored detector) and combined by
undertone_adapter.aggregate, exactly as the live mirror does. People are synthetic so their true skin
colour, and therefore the right answer, is known.

Usage:  .venv/bin/python scripts/undertone_benchmark.py [people=150] [out=reports/undertone-benchmark.csv]
Then:   python3 scripts/benchmark_to_excel.py reports/undertone-benchmark.csv  (needs openpyxl)
"""

from __future__ import annotations

import csv
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from kyra_sidecar import lighting, undertone_adapter  # noqa: E402
from kyra_sidecar.color import classify_depth  # noqa: E402
from kyra_sidecar.vendor.undertone.color import lab_to_linear_rgb, linear_to_srgb, srgb_to_linear  # noqa: E402
from kyra_sidecar.vendor.undertone.detect import warm_cool_position  # noqa: E402
from tests.scene import EYES, FACE, H, W, mondrian, photograph, visitor  # noqa: E402

FRAMES_PER_VISIT = 8
GREY_CARD = 0.45  # linear reflectance of the calibration card
WALLS = {"varied": (1.0, 1.0, 1.0), "beige": (1.25, 1.05, 0.7), "blue-grey": (0.85, 0.95, 1.2), "yellow": (1.3, 1.15, 0.5)}
CAMERA_AWB_STRENGTH = 0.85  # webcams neutralise most, not all, of the frame's average colour


@dataclass(frozen=True)
class Condition:
    id: str
    description: str
    light: tuple[float, float, float] = (1.0, 1.0, 1.0)
    exposure: float = 1.0
    wall: str = "varied"
    mode: str = "live"          # live = room model learned from the empty room; home = live frames, but someone is
                                # always in view so the room is never learned; photo = a single still
    grey_card: bool = False
    eyes_open: bool = True
    scale: float = 1.0          # 0.5 = standing twice as far away (face about 70 px wide)
    camera_awb: bool = False    # the camera's own auto white balance (grey-world over the whole frame)


CONDITIONS = [
    Condition("C01", "Studio: neutral light, grey card in view", grey_card=True),
    Condition("C02", "Mirror, neutral light (room model)"),
    Condition("C03", "Mirror, warm tungsten light", light=(1.3, 1.0, 0.68)),
    Condition("C04", "Mirror, cool LED light", light=(0.82, 1.0, 1.28)),
    Condition("C05", "Mirror, green fluorescent tint", light=(0.88, 1.06, 0.9)),
    Condition("C06", "Mirror, dim warm room (30% under-exposed)", light=(1.2, 1.0, 0.75), exposure=0.7),
    Condition("C07", "Mirror, cool light against a blue-grey wall", light=(0.82, 1.0, 1.28), wall="blue-grey"),
    Condition("C08", "Mirror, visitor twice as far away", scale=0.5),
    Condition("C09", "Mirror, warm light with grey card", light=(1.3, 1.0, 0.68), grey_card=True),
    Condition("C10", "Photo upload, bright (25% over-exposed), beige wall", exposure=1.25, wall="beige", mode="photo"),
    Condition("C11", "Photo upload, magenta LED", light=(1.1, 0.92, 1.08), mode="photo"),
    Condition("C12", "Photo upload, warm light, beige wall, eyes closed", light=(1.3, 1.0, 0.68), wall="beige", mode="photo", eyes_open=False),
    Condition("C13", "Home: yellow walls, warm bulb, camera auto white balance", light=(1.15, 1.0, 0.8), wall="yellow", mode="home", camera_awb=True),
    Condition("C14", "Home: yellow walls, daylight, camera auto white balance", wall="yellow", mode="home", camera_awb=True),
    Condition("C15", "Mirror: yellow walls, camera auto white balance (room model)", light=(1.15, 1.0, 0.8), wall="yellow", camera_awb=True),
]


def camera_white_balance(rgb: np.ndarray) -> np.ndarray:
    """What a webcam's auto white balance does: estimates the light from the frame's average colour (so a
    yellow wall reads as warm light), keeps only realistic light colours (the black-body locus, within the
    range a camera's presets cover) and removes most of it."""
    linear = srgb_to_linear(rgb.astype(np.float64) / 255.0)
    uv = lighting.to_uv(linear.reshape(-1, 3).mean(axis=0))
    uv = lighting.toward_locus(uv, keep=0.0)
    uv = np.clip(uv, [-0.25, -0.45], [0.45, 0.35])  # about 2700 K (warm bulb) to 8000 K (shade)
    gains = lighting.gains_for(uv * CAMERA_AWB_STRENGTH)
    return np.clip(linear_to_srgb(np.clip(linear * gains, 0, 1)) * 255, 0, 255).astype(np.uint8)


def make_people(count: int, seed: int = 7) -> list[dict]:
    """Skin colours spread over real ranges: L* 28–78 (deep to fair), hue 40–70°, chroma 13–30.
    Some people have flushed cheeks, everyone has slightly different eye whites."""
    rng = np.random.default_rng(seed)
    people = []
    for i in range(count):
        L = 28 + 50 * (i + rng.random()) / count            # stratified over depth
        hue = rng.uniform(40, 70)
        chroma = rng.uniform(13, 30) * (0.85 if L > 70 else 1.0)
        a, b = chroma * np.cos(np.radians(hue)), chroma * np.sin(np.radians(hue))
        people.append({
            "id": f"P{i + 1:03d}",
            "lab": (float(L), float(a), float(b)),
            "flushed": bool(rng.random() < 0.2),             # cheeks redder than forehead and chin
            "sclera": float(rng.uniform(0.9, 1.0)),          # 1 = white; lower = slightly yellow eye whites
            "texture": float(rng.uniform(0.02, 0.05)),       # pore/texture variation in lightness
            "seed": int(rng.integers(1_000_000)),
        })
    rng.shuffle(people)  # visit order mixes skin tones, as at a real mirror
    return people


def truth(lab: tuple[float, float, float]) -> dict:
    """What the detector should report for this skin under perfect conditions."""
    L, a, b = lab
    config = undertone_adapter.make_config(None, calibrated_white_balance=False)
    hue = float(np.degrees(np.arctan2(b, a)))
    position = warm_cool_position(hue, config, L=L, a=a, b=b)
    ita = float(np.degrees(np.arctan((L - 50) / b)))
    return {"hue": hue, "chroma": float(np.hypot(a, b)), "ita": ita, "depth": classify_depth(ita),
            "undertone": position["label"], "olive": bool(position.get("is_olive")), "score": float(position["score"])}


def render_person(room: np.ndarray, person: dict, eyes_open: bool):
    """Reflectance scene of the person, with skin texture, flushed cheeks and their own eye-white tint."""
    scene, landmarks, mask = visitor(room, person["lab"], eyes=eyes_open)
    rng = np.random.default_rng(person["seed"])
    cx, cy, rx, ry = FACE
    yy, xx = np.mgrid[0:H, 0:W]
    face = ((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2 <= 1
    eyes = np.zeros_like(face)
    for ex, ey in EYES:
        eyes |= ((xx - ex) / 22) ** 2 + ((yy - ey) / 8) ** 2 <= 1
    skin = face & ~eyes
    texture = 1 + person["texture"] * cv2.GaussianBlur(rng.standard_normal((H, W)).astype(np.float32), (0, 0), 1.2)[..., None] * 3
    scene = np.where(skin[..., None], np.clip(scene * texture, 0, 1), scene)
    if person["flushed"]:
        L, a, b = person["lab"]
        flushed = np.clip(lab_to_linear_rgb(np.array([L - 2, a + 6, b])), 0, 1)
        for side in (-1, 1):
            cheek = ((xx - (cx + side * 38)) / 16) ** 2 + ((yy - (cy + 18)) / 16) ** 2 <= 1
            scene[cheek & skin] = flushed * texture[cheek & skin]
    if eyes_open:
        tint = np.array([1.0, 0.99, person["sclera"]])
        whites = eyes & (scene.mean(axis=-1) > 0.4)
        scene[whites] = scene[whites] * tint
    return scene, landmarks, mask


def card_rgb(light, exposure) -> list[float]:
    linear = np.clip(GREY_CARD * np.asarray(light) * exposure, 0, 1)
    return (linear_to_srgb(linear) * 255).tolist()


def learned_room(condition: Condition) -> lighting.RoomLight:
    model = lighting.RoomLight()
    for seed in range(12):
        frame = photograph(ROOMS[condition.wall], condition.light, condition.exposure, seed=900 + seed) if condition.camera_awb \
            else photograph(ROOMS[condition.wall], seed=900 + seed)
        model.observe(camera_white_balance(frame) if condition.camera_awb else frame, present=False)
    return model


def run_visit(person: dict, condition: Condition, room_model, config) -> dict:
    scene, landmarks, mask = render_person(ROOMS[condition.wall], person, condition.eyes_open)
    smoother = lighting.LightSmoother() if condition.mode in ("live", "home") else None
    reference = card_rgb(condition.light, condition.exposure) if condition.grey_card else None
    frames = []
    for frame in range(1 if condition.mode == "photo" else FRAMES_PER_VISIT):
        rgb = photograph(scene, condition.light, condition.exposure, seed=person["seed"] + frame)
        if condition.camera_awb:
            rgb = camera_white_balance(rgb)
        frame_mask = mask
        if condition.scale != 1.0:
            rgb = cv2.resize(rgb, None, fx=condition.scale, fy=condition.scale, interpolation=cv2.INTER_AREA)
            frame_mask = cv2.resize(mask, (rgb.shape[1], rgb.shape[0]), interpolation=cv2.INTER_NEAREST)
        frames.append(undertone_adapter.measure_frame(
            rgb, landmarks, frame_mask, reference, config, people_mask=frame_mask,
            room=room_model if condition.mode == "live" else None, smoother=smoother,
            card_baseline_rgb=card_rgb((1, 1, 1), 1.0) if condition.grey_card else None))
    return {"frames": frames, "result": undertone_adapter.aggregate([f for f in frames if f], config)}


COLUMNS = [
    "test_id", "person_id", "condition_id", "condition", "mode", "light", "exposure", "wall", "grey_card", "eyes_open",
    "distance", "flushed_cheeks", "true_L", "true_a", "true_b", "true_hue", "true_chroma", "true_ita", "true_depth",
    "true_undertone", "true_olive", "true_score", "measured_L", "measured_a", "measured_b", "measured_hue",
    "measured_ita", "measured_depth", "measured_undertone", "measured_subtype", "measured_olive", "score",
    "ci95_low", "ci95_high", "stable", "confidence", "detector_score", "require_confirmation", "frames_used",
    "frames_passed", "hue_spread", "lighting_method", "lighting_confidence", "light_detected", "exposure_correction",
    "lighting_uncertain", "flushing_detected", "quality_failures", "ms_per_frame",
]


def row_for(index: int, person: dict, condition: Condition, visit: dict, ms: float) -> dict:
    t = truth(person["lab"])
    r = visit["result"] or {}
    wc = r.get("warmCool") or {}
    ci = wc.get("ci95") or [None, None]
    light = r.get("lighting") or {}
    scores = [f["confidence"] for f in visit["frames"] if f and "confidence" in f]
    return {
        "test_id": f"T{index:04d}", "person_id": person["id"], "condition_id": condition.id,
        "condition": condition.description, "mode": condition.mode,
        "light": "neutral" if condition.light == (1.0, 1.0, 1.0) else "/".join(f"{v:g}" for v in condition.light),
        "exposure": condition.exposure, "wall": condition.wall, "grey_card": condition.grey_card,
        "eyes_open": condition.eyes_open, "distance": "far" if condition.scale < 1 else "normal",
        "flushed_cheeks": person["flushed"],
        "true_L": round(person["lab"][0], 2), "true_a": round(person["lab"][1], 2), "true_b": round(person["lab"][2], 2),
        "true_hue": round(t["hue"], 2), "true_chroma": round(t["chroma"], 2), "true_ita": round(t["ita"], 2),
        "true_depth": t["depth"], "true_undertone": t["undertone"], "true_olive": t["olive"], "true_score": round(t["score"], 3),
        "measured_L": (r.get("lab") or {}).get("L"), "measured_a": (r.get("lab") or {}).get("a"),
        "measured_b": (r.get("lab") or {}).get("b"), "measured_hue": r.get("hueAngle"), "measured_ita": r.get("ita"),
        "measured_depth": r.get("skinDepth", "none"), "measured_undertone": r.get("skinUndertone", "none"),
        "measured_subtype": r.get("skinSubtype") or "", "measured_olive": bool(wc.get("olive")),
        "score": wc.get("score"), "ci95_low": ci[0], "ci95_high": ci[1],
        "stable": "unknown" if wc.get("stable") is None else bool(wc.get("stable")),
        "confidence": r.get("confidence", "none"),
        "detector_score": round(float(np.mean(scores)), 3) if scores else None,
        "require_confirmation": r.get("requireConfirmation", True),
        "frames_used": r.get("framesUsed", 0), "frames_passed": r.get("framesPassed", 0), "hue_spread": r.get("hueSpread"),
        "lighting_method": light.get("method", ""), "lighting_confidence": light.get("confidence"),
        "light_detected": light.get("cast", ""), "exposure_correction": light.get("exposure"),
        "lighting_uncertain": bool(r.get("lightingUncertain")), "flushing_detected": bool(r.get("flushing")),
        "quality_failures": " ".join(r.get("qualityFailures") or []), "ms_per_frame": round(ms, 1),
    }


ROOMS = {name: mondrian(np.random.default_rng(3), tint) for name, tint in WALLS.items()}


def main() -> None:
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 150
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "reports" / "undertone-benchmark.csv"
    out.parent.mkdir(parents=True, exist_ok=True)
    people = make_people(count)
    rows, index, started = [], 0, time.time()
    selected = [c.strip() for c in os.environ.get("BENCH_CONDITIONS", "").split(",") if c.strip()]
    for condition in [c for c in CONDITIONS if not selected or c.id in selected]:
        config = undertone_adapter.make_config(None, calibrated_white_balance=condition.grey_card)
        # One room model per condition, kept across its visitors, as on a real mirror (it learns from their eyes).
        room_model = learned_room(condition) if condition.mode == "live" else None
        for person in people:
            index += 1
            t0 = time.time()
            visit = run_visit(person, condition, room_model, config)
            frames = max(1, len(visit["frames"]))
            rows.append(row_for(index, person, condition, visit, (time.time() - t0) * 1000 / frames))
        done = [r for r in rows if r["condition_id"] == condition.id]
        right = sum(r["measured_undertone"] == r["true_undertone"] for r in done)
        print(f"{condition.id} {condition.description:55s} correct {right}/{len(done)}  ({time.time() - started:.0f} s)", flush=True)
    with out.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=COLUMNS)
        writer.writeheader()
        writer.writerows(rows)
    print(f"Wrote {len(rows)} tests to {out}")


if __name__ == "__main__":
    main()
