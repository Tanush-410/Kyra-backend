"""Lighting compensation: the same face must measure the same under different lights, walls and exposures."""

import numpy as np
import pytest

from kyra_sidecar import lighting, undertone_adapter
from tests.scene import mondrian, photograph, visitor

CONFIG = undertone_adapter.make_config(None, calibrated_white_balance=False)
SKINS = [(62, 13, 24), (40, 14, 20), (55, 15, 17)]
LIGHTS = {"neutral": (1.0, 1.0, 1.0), "warm": (1.3, 1.0, 0.68), "cool": (0.82, 1.0, 1.28),
          "green": (0.88, 1.06, 0.9), "magenta": (1.1, 0.92, 1.08)}
BEIGE = (1.25, 1.05, 0.7)


def hue(lab) -> float:
    return float(np.degrees(np.arctan2(lab[2], lab[1])))


def learned_room(room, light=(1.0, 1.0, 1.0), exposure=1.0) -> lighting.RoomLight:
    model = lighting.RoomLight()
    for seed in range(15):
        model.observe(photograph(room, light, exposure, seed=seed), present=False)
    assert model.ready
    return model


def test_gains_neutralise_a_light_and_keep_a_greys_luminance():
    light = np.array([1.3, 1.0, 0.68])
    corrected = light * lighting.gains_for(lighting.to_uv(light))
    assert np.allclose(corrected, corrected[0])
    assert corrected @ lighting.LUMA == pytest.approx(light @ lighting.LUMA)


def test_light_locus_passes_through_neutral_and_names_casts():
    assert np.allclose(lighting.toward_locus([0.0, 0.0]), 0, atol=1e-6)
    # A purely green "light" is mostly a green wall: the pull toward the locus removes much of it.
    assert np.linalg.norm(lighting.toward_locus([-0.2, -0.2])) < np.linalg.norm([-0.2, -0.2])
    assert lighting.describe_cast(lighting.to_uv([1.3, 1.0, 0.68])).startswith("warm")
    assert lighting.describe_cast(lighting.to_uv([0.82, 1.0, 1.28])).startswith("cool")
    assert lighting.describe_cast([0.0, 0.0]) == "neutral light"


def test_eye_whites_give_the_light_and_skin_coloured_eyes_are_rejected():
    room = mondrian(np.random.default_rng(3))
    with_eyes, landmarks, person = visitor(room, (62, 13, 24))
    light = (1.3, 1.0, 0.68)
    result = undertone_adapter.measure_frame(photograph(with_eyes, light), landmarks, person, None, CONFIG)
    assert "sclera" in result["lighting"]["cues"]
    assert np.allclose(result["lighting"]["cues"]["sclera"]["uv"], lighting.to_uv(light), atol=0.03)

    no_eyes, landmarks, person = visitor(room, (62, 13, 24), eyes=False)
    result = undertone_adapter.measure_frame(photograph(no_eyes, light), landmarks, person, None, CONFIG)
    assert "sclera" not in result["lighting"]["cues"]


@pytest.mark.parametrize("light", LIGHTS)
@pytest.mark.parametrize("skin", SKINS)
def test_undertone_holds_under_coloured_light_even_against_a_beige_wall(skin, light):
    # Plain gray-world on this wall was off by 14–18 degrees of hue even in neutral light.
    scene, landmarks, person = visitor(mondrian(np.random.default_rng(3), BEIGE), skin)
    result = undertone_adapter.measure_frame(photograph(scene, LIGHTS[light]), landmarks, person, None, CONFIG)
    assert abs(result["hue"] - hue(skin)) < 3.0, result["lighting"]


@pytest.mark.parametrize("exposure", [0.75, 1.25])
@pytest.mark.parametrize("light", ["neutral", "warm", "cool"])
def test_room_model_removes_light_and_exposure_changes(light, exposure):
    # The change since the empty room is measured exactly; the baseline is tested in the next test.
    skin = (55, 15, 17)
    room = mondrian(np.random.default_rng(3))
    model = learned_room(room)
    scene, landmarks, person = visitor(room, skin)
    rgb = photograph(scene, LIGHTS[light], exposure)
    result = undertone_adapter.measure_frame(rgb, landmarks, person, None, CONFIG, room=model)
    assert result["lighting"]["method"].startswith("room")
    assert abs(result["lab"][0] - skin[0]) < 1.5, "depth must not follow the camera's exposure"
    assert abs(result["hue"] - hue(skin)) < 2.5


def test_room_baseline_learns_from_visitors_eyes():
    room = mondrian(np.random.default_rng(3), BEIGE)
    model = learned_room(room)
    skin = (62, 13, 24)
    blind, blind_landmarks, blind_person = visitor(room, skin, eyes=False)

    def error():
        rgb = photograph(blind, seed=99)
        result = undertone_adapter.measure_frame(rgb, blind_landmarks, blind_person, None, CONFIG, room=model)
        return abs(result["hue"] - hue(skin))

    before = error()
    for other in [(40, 14, 20), (70, 9, 15), (55, 15, 17)]:
        scene, landmarks, person = visitor(room, other)
        for seed in range(25):
            undertone_adapter.measure_frame(photograph(scene, seed=seed), landmarks, person, None, CONFIG, room=model)
    after = error()
    assert after < 3 and after < before, (before, after)


def test_room_model_waits_for_an_empty_room_and_ignores_a_visitor():
    room = mondrian(np.random.default_rng(3))
    model = lighting.RoomLight(settle_frames=4)
    for seed in range(3):
        model.observe(photograph(room, seed=seed), present=False)
    model.observe(photograph(room, seed=3), present=True)  # someone stepped in: the streak restarts
    for seed in range(3):
        model.observe(photograph(room, seed=seed), present=False)
    assert model.reference is None


def test_smoother_steadies_the_correction():
    smoother = lighting.LightSmoother(alpha=0.3)
    first = smoother.apply(lighting.Correction(np.ones(3), 1.0, np.array([0.1, -0.1]), "scene", 1.0))
    jumped = smoother.apply(lighting.Correction(np.ones(3), 1.0, np.array([0.3, -0.3]), "scene", 1.0))
    assert np.allclose(first.uv, [0.1, -0.1]) and 0.1 < jumped.uv[0] < 0.2


def test_grey_card_normalises_exposure():
    half_bright = [93.0, 93.0, 93.0]  # an 18% card photographed darker than at calibration
    by_baseline = lighting.card_correction(half_bright, baseline_rgb=[128.0, 128.0, 128.0])
    assert by_baseline.exposure > 1.5 and np.allclose(by_baseline.gains, 1.0, atol=1e-6)
    by_lightness = lighting.card_correction([118.0, 118.0, 118.0], card_lightness=50.0)
    assert by_lightness.exposure == pytest.approx(1.0, abs=0.02)


def test_aggregate_reports_the_light_and_flags_a_guess():
    def frame(confidence):
        return {"ok": True, "lab": [62, 12, 26], "hue": 65.2, "hueStd": 1.0, "regions": 4, "pixels": 3000,
                "confidence": 0.8, "failures": [], "flushing": False, "makeupSuspected": False,
                "whiteBalance": "auto", "facePx": 200.0,
                "lighting": {"method": "scene", "confidence": confidence, "cast": "warm (yellow-orange) light",
                             "castUV": [0.2, -0.3], "exposure": 1.0, "cues": {}}}

    sure = undertone_adapter.aggregate([frame(0.9)] * 6, CONFIG)
    assert sure["lighting"]["cast"].startswith("warm") and not sure["lightingUncertain"]
    guess = undertone_adapter.aggregate([frame(0.1)] * 6, CONFIG)
    assert guess["lightingUncertain"] and undertone_adapter.LIGHTING_HINT in guess["hints"]
    mixed = undertone_adapter.aggregate([frame(0.1)] * 3 + [frame(0.9)] * 3, CONFIG)
    assert mixed["framesUsed"] == 3, "well-lit frames are preferred"
