import numpy as np
import pytest

from kyra_sidecar.calibration import Calibration
from kyra_sidecar.capture import aggregate_skin, crop_box
from kyra_sidecar.color import classify_depth, classify_undertone, gray_world_gains, srgb_to_lab
from kyra_sidecar.guidance import evaluate
from kyra_sidecar.perception import FrameAnalysis


def test_lab_matches_reference_values():
    np.testing.assert_allclose(srgb_to_lab(np.array([255, 255, 255])), [100, 0, 0], atol=0.05)
    np.testing.assert_allclose(srgb_to_lab(np.array([0, 0, 0])), [0, 0, 0], atol=0.05)
    np.testing.assert_allclose(srgb_to_lab(np.array([255, 0, 0])), [53.24, 80.09, 67.2], atol=0.3)


def test_undertone_and_depth_bands():
    assert classify_undertone(40) == "cool"
    assert classify_undertone(54) == "neutral"
    assert classify_undertone(65) == "warm"
    assert [classify_depth(v) for v in (60, 45, 30, 15, -20)] == ["fair", "light", "medium", "tan", "deep"]


def test_gray_world_corrects_a_colour_cast():
    scene = np.full((100, 100, 3), 120.0) * np.array([1.2, 1.0, 0.8])
    gains = gray_world_gains(scene)
    np.testing.assert_allclose((scene[0, 0] * gains), [120, 120, 120], rtol=0.02)


def test_height_calibration_single_and_two_distance(tmp_path):
    calibration = Calibration(tmp_path / "calibration.json")
    assert calibration.estimate_height_cm(0.9, 0.8) is None
    calibration.add_height_sample(foot_y=0.9, pixel_height=0.85, height_cm=170)
    assert calibration.estimate_height_cm(0.9, 0.85) == pytest.approx(170, abs=0.1)
    assert calibration.estimate_height_cm(0.9, 0.80) == pytest.approx(160, abs=0.1)

    # Further back: feet higher in frame and the same person looks smaller.
    calibration.add_height_sample(foot_y=0.8, pixel_height=0.65, height_cm=170)
    assert calibration.estimate_height_cm(0.9, 0.85) == pytest.approx(170, abs=0.5)
    assert calibration.estimate_height_cm(0.8, 0.65) == pytest.approx(170, abs=0.5)

    reloaded = Calibration(tmp_path / "calibration.json")
    assert reloaded.summary()["height"]["samples"] == 2


def test_white_balance_calibration_persists(tmp_path):
    calibration = Calibration(tmp_path / "calibration.json")
    calibration.set_white_balance(np.array([0.9, 1.0, 1.15]), [140, 126, 110])
    np.testing.assert_allclose(Calibration(tmp_path / "calibration.json").white_balance_gains(), [0.9, 1.0, 1.15])
    assert calibration.reset()["whiteBalance"]["calibrated"] is False


def standing_person(**overrides) -> FrameAnalysis:
    landmarks = np.zeros((33, 4))
    landmarks[:, 3] = 1.0
    landmarks[0, :2] = [0.5, 0.12]          # nose
    landmarks[[11, 12], 1] = 0.25            # shoulders
    landmarks[[23, 24], 1] = 0.5             # hips
    landmarks[[27, 28], 1] = 0.9             # ankles
    landmarks[[11, 23, 27], 0] = 0.45
    landmarks[[12, 24, 28], 0] = 0.55
    analysis = FrameAnalysis(
        width=600, height=900, person_count=1, landmarks=landmarks, bbox=(0.4, 0.05, 0.6, 0.95),
        head_top_y=0.05, foot_y=0.94, face_landmarks=np.zeros((478, 2)), luminance=120, sharpness=200,
    )
    for key, value in overrides.items():
        setattr(analysis, key, value)
    return analysis


@pytest.mark.parametrize(
    "overrides, motion, expected",
    [
        ({"person_count": 0, "landmarks": None}, 0, "no_person"),
        ({"luminance": 20}, 0, "too_dark"),
        ({"feet_cut": True}, 0, "too_close"),
        ({"head_top_y": 0.6}, 0, "too_far"),
        ({"bbox": (0.0, 0.05, 0.3, 0.95)}, 0, "move_right"),
        ({"bbox": (0.75, 0.05, 0.95, 0.95)}, 0, "move_left"),
        ({"face_landmarks": None}, 0, "face_hidden"),
        ({}, 0.05, "moving"),
        ({"sharpness": 5}, 0, "blurry"),
        ({}, 0, "ready"),
    ],
)
def test_guidance_priorities(overrides, motion, expected):
    assert evaluate(standing_person(**overrides), motion)["state"] == expected


def test_guidance_rejects_sitting():
    sitting = standing_person()
    sitting.landmarks[[27, 28], 1] = 0.55
    assert evaluate(sitting)["state"] == "not_standing"


def test_guidance_direction_flips_without_mirroring():
    off_left = standing_person(bbox=(0.0, 0.05, 0.3, 0.95))
    assert evaluate(off_left, mirrored=False)["state"] == "move_left"


def test_skin_aggregation_confidence():
    def sample(hue_shift=0.0, method="calibrated"):
        return {"lab": np.array([60.0, 15.0 + hue_shift, 20.0]), "count": 300, "whiteBalance": method}

    assert aggregate_skin([]) is None
    assert aggregate_skin([sample() for _ in range(10)])["confidence"] == "high"
    assert aggregate_skin([sample(method="gray-world") for _ in range(10)])["confidence"] == "medium"
    assert aggregate_skin([sample(hue_shift=i * 3) for i in range(10)])["confidence"] == "medium"
    assert aggregate_skin([{**sample(), "count": 100}])["confidence"] == "low"
    assert aggregate_skin([{**sample(), "count": 700}])["confidence"] == "medium"


def test_crop_box_is_portrait_and_frames_the_person():
    analysis = standing_person()
    x, y, w, h = crop_box(analysis, 1920, 1080)
    assert abs(w / h - 1024 / 1536) < 0.01
    assert y <= 0.05 * 1080 and y + h >= 0.94 * 1080
    assert x <= 0.4 * 1920 and x + w >= 0.6 * 1920


def test_silhouette_matching_survives_a_noisy_webcam_outline():
    """A jagged, notched outline (webcam segmentation) must not put stair-steps or black notches in the render."""
    from kyra_sidecar.silhouette import match_silhouette

    h, w = 600, 400
    generated = np.zeros((h, w, 3), np.uint8)
    generated[:, 140:260] = (40, 110, 100)  # a 120 px wide trouser leg
    generated_mask = (generated[..., 1] > 0).astype(np.float32)
    rng = np.random.default_rng(0)
    original = np.zeros((h, w), np.float32)
    for y0 in range(0, h, 18):  # the visitor's leg: 100 px wide, edges jumping every 18 rows
        d = int(rng.integers(-8, 9))
        original[y0:y0 + 18, 150 + d:250 + d] = 1
    for y in (120, 260, 400):  # segmentation holes at the edge
        original[y:y + 14, 150:166] = 0

    result, info = match_silhouette(generated, generated_mask, original, 20, 580)
    assert info["applied"] and info["widthErrorAfter"] < info["widthErrorBefore"]
    body = result[40:560, :, 1] > 50
    left = np.array([np.flatnonzero(r)[0] for r in body])
    right = np.array([np.flatnonzero(r)[-1] for r in body])
    assert np.abs(np.diff(left)).max() <= 4 and np.abs(np.diff(right)).max() <= 4, "no stair-steps"
    assert (right - left).min() > 0.9 * 100, "no notches cut into the leg"
    assert 100 <= np.median(right - left) <= 113, "matched to the visitor's width, garment up to 12% looser"


def test_a_visitor_counts_as_gone_after_10_seconds_out_of_view(monkeypatch):
    # 13 Nov 2026: then the backend gives them LEAVE_GRACE_MS (30 s) of "Still here?" before the visit ends.
    from kyra_sidecar.config import Config

    monkeypatch.delenv("ABSENT_AFTER_MS", raising=False)
    assert Config().absent_after_ms == 10000
    monkeypatch.setenv("ABSENT_AFTER_MS", "12000")
    assert Config().absent_after_ms == 12000
