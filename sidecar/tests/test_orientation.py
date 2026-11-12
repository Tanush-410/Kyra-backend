"""CAMERA_ROTATION suggestions (orientation.py): every mounting angle, mirrored or not, already set or not."""
import os
from pathlib import Path

import cv2
import numpy as np
import pytest

from kyra_sidecar.orientation import ROTATE, suggest_rotation

MODELS = Path(__file__).resolve().parent.parent / "models"
IMAGES = Path(os.environ.get("KYRA_TEST_IMAGES", "/nonexistent"))


def turn(image, degrees):
    """Clockwise, like CAMERA_ROTATION."""
    return image if degrees % 360 == 0 else cv2.rotate(image, ROTATE[degrees % 360])


def camera_frames(upright, needed, current, mirrored):
    """What the camera loop produces when the camera needs `needed` but is set to `current`."""
    raw = turn(upright, (360 - needed) % 360)  # the camera's own picture: turning it by `needed` is upright
    frame = turn(raw, current)
    return cv2.flip(frame, 1) if mirrored else frame


class MarkerDetector:
    """Stands in for the face detector: "sees" an upright face when the image's bright marker is top-left,
    which also tells a mirrored picture from a true one."""

    def setInputSize(self, size):
        pass

    def detect(self, bgr):
        h, w = bgr.shape[:2]
        gray = bgr.mean(axis=2)
        corner = gray[: h // 3, : w // 3].mean()
        if corner < 200 or corner < max(gray[: h // 3, -(w // 3):].mean(), gray[-(h // 3):, : w // 3].mean()) + 50:
            return 1, None
        # box, right eye, left eye, nose, mouth corners (eyes above mouth), score
        return 1, np.array([[0, 0, 10, 10, 3, 3, 7, 3, 5, 5, 4, 8, 6, 8, 0.95]], np.float32)


def marker_image():
    image = np.full((300, 200, 3), 40, np.uint8)
    image[:100, :66] = 255
    return image


@pytest.mark.parametrize("mirrored", [True, False])
@pytest.mark.parametrize("current", [0, 90, 180, 270])
@pytest.mark.parametrize("needed", [0, 90, 180, 270])
def test_suggests_the_rotation_that_makes_the_picture_upright(needed, current, mirrored):
    frame = camera_frames(marker_image(), needed, current, mirrored)
    result = suggest_rotation(frame, current, mirrored, MarkerDetector())
    assert result["found"] and result["suggested"] == needed
    assert result["correct"] == (needed == current)


def test_no_face_no_guess():
    blank = np.full((300, 200, 3), 40, np.uint8)
    result = suggest_rotation(blank, 0, True, MarkerDetector())
    assert result["found"] is False and "suggested" not in result


@pytest.mark.skipif(not (MODELS / "face_detection_yunet_2023mar.onnx").exists() or not (IMAGES / "standing.png").exists(),
                    reason="needs the face model and KYRA_TEST_IMAGES/standing.png (a photo with a face)")
@pytest.mark.parametrize("needed", [0, 90, 270])
def test_real_face_detector_finds_a_camera_on_its_side(needed):
    detector = cv2.FaceDetectorYN.create(str(MODELS / "face_detection_yunet_2023mar.onnx"), "", (320, 320), 0.6, 0.3, 5000)
    upright = cv2.imread(str(IMAGES / "standing.png"))
    result = suggest_rotation(camera_frames(upright, needed, 0, True), 0, True, detector)
    assert result["found"] and result["suggested"] == needed
