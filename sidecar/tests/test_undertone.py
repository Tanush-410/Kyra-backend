"""The vendored undertone detector as wired into the sidecar (undertone_adapter)."""

import numpy as np

from kyra_sidecar import undertone_adapter
from kyra_sidecar.vendor.undertone.color import lab_to_srgb


def frame(lab, ok=True, hue_std=1.0):
    L, a, b = lab
    return {"ok": ok, "lab": [L, a, b], "hue": float(np.degrees(np.arctan2(b, a))), "hueStd": hue_std,
            "regions": 4, "pixels": 3000, "confidence": 0.8, "failures": [] if ok else ["uneven_color"],
            "flushing": False, "makeupSuspected": False, "whiteBalance": "gray-world", "facePx": 200.0}


def test_aggregate_labels_warm_and_cool_and_reports_uncertainty():
    config = undertone_adapter.make_config(None, calibrated_white_balance=False)
    warm = undertone_adapter.aggregate([frame((62, 12, 26))] * 6, config)  # hue ~65
    cool = undertone_adapter.aggregate([frame((62, 16, 13))] * 6, config)  # hue ~39
    assert warm["method"] == "undertone-detector"
    assert warm["skinUndertone"] == "warm" and cool["skinUndertone"] == "cool"
    assert warm["warmCool"]["score"] > 0 > cool["warmCool"]["score"]
    # Without a grey card the reading is never "high", so the mirror asks the visitor to confirm.
    assert warm["confidence"] == "medium" and warm["requireConfirmation"] is True


def test_grey_card_and_clean_frames_give_high_confidence():
    config = undertone_adapter.make_config(None, calibrated_white_balance=True)
    result = undertone_adapter.aggregate([frame((62, 12, 26))] * 6, config)
    assert result["confidence"] == "high" and result["requireConfirmation"] is False


def test_failed_frames_surface_hints_and_low_confidence_on_a_boundary():
    config = undertone_adapter.make_config(None, calibrated_white_balance=False)
    result = undertone_adapter.aggregate([frame((62, 14, 20.5), ok=False, hue_std=9.0)] * 3, config)
    assert result["qualityFailures"] == ["uneven_color"] and result["hints"]
    assert result["framesPassed"] == 0


def test_fitted_anchors_move_the_neutral_point():
    config = undertone_adapter.make_config({"neutral_hue": 45.0, "hue_span": 10.0, "neutral_band": 0.25},
                                           calibrated_white_balance=False)
    result = undertone_adapter.aggregate([frame((62, 14, 16))] * 6, config)  # hue ~49: warm of 45
    assert result["skinUndertone"] == "warm" and result["warmCool"]["calibrated"] is True


def test_measure_frame_reads_a_synthetic_face():
    # A flat skin-coloured face on grey: every region should sample it and recover its hue.
    skin = np.clip(lab_to_srgb(np.array([62.0, 13.0, 24.0])) * 255, 0, 255)
    rgb = np.full((480, 480, 3), 128, dtype=np.uint8)
    rgb[100:380, 140:340] = skin.astype(np.uint8)
    rng = np.random.default_rng(0)
    rgb = np.clip(rgb + rng.normal(0, 1.5, rgb.shape), 0, 255).astype(np.uint8)
    # Landmarks spread over the face box, so the region hulls land inside it.
    landmarks = np.zeros((478, 2))
    landmarks[:, 0] = rng.uniform(150, 330, 478) / 480
    landmarks[:, 1] = rng.uniform(110, 370, 478) / 480
    person = np.zeros((480, 480), np.float32)
    person[100:380, 140:340] = 1
    config = undertone_adapter.make_config(None, calibrated_white_balance=False)
    expected = np.degrees(np.arctan2(24, 13))
    # Gray-world on the background only (the person is excluded), then a grey-card reference.
    for mask, reference in ((person, None), (None, [128, 128, 128])):
        result = undertone_adapter.measure_frame(rgb, landmarks, mask, reference, config)
        assert result is not None and "lab" in result, result
        assert abs(result["hue"] - expected) < 1.5 and abs(result["lab"][0] - 62) < 1.5


def test_measure_frame_skips_tiny_faces():
    landmarks = np.full((478, 2), 0.5)
    landmarks[0] = [0.51, 0.51]
    config = undertone_adapter.make_config(None, calibrated_white_balance=False)
    assert undertone_adapter.measure_frame(np.zeros((480, 640, 3), np.uint8), landmarks, None, None, config) is None



def test_aggregate_reports_swatch_statement_and_styling():
    config = undertone_adapter.make_config(None, calibrated_white_balance=False)
    warm = undertone_adapter.aggregate([frame((62, 21, 35))] * 6, config)  # hue 59, b - 1.25a = 8.75: not olive
    assert warm["skinHex"].startswith("#") and len(warm["skinHex"]) == 7
    assert warm["statement"].startswith("Your undertone is WARM")
    assert warm["paletteKey"] == "warm" and "Yellow Gold" in warm["styling"]["best_metals"]


def test_olive_needs_a_clear_green_yellow_offset():
    config = undertone_adapter.make_config(None, calibrated_white_balance=False)
    olive = undertone_adapter.aggregate([frame((60, 8, 21))] * 6, config)  # b - 1.25a = 11
    plain = undertone_adapter.aggregate([frame((60, 8, 15))] * 6, config)  # 5: olive before the upstream fix
    assert olive["warmCool"]["olive"] is True and olive["paletteKey"] == "olive"
    assert "Bronze" in olive["styling"]["best_metals"]
    assert plain["warmCool"]["olive"] is False and plain["paletteKey"] != "olive"
