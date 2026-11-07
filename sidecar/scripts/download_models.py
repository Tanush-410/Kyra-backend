"""Download the on-device models the sidecar needs into sidecar/models/."""

import sys
import urllib.request
from pathlib import Path

MODELS_DIR = Path(__file__).resolve().parent.parent / "models"

MODELS = {
    # MediaPipe pose landmarker (33 landmarks + person segmentation mask)
    "pose_landmarker_full.task": "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task",
    # MediaPipe face landmarker (478-point face mesh)
    "face_landmarker.task": "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
    # MediaPipe gesture recognizer (thumbs up/down, victory, open palm...) for hands-free control
    "gesture_recognizer.task": "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task",
    # OpenCV Zoo YuNet face detector, used to align faces for SFace
    "face_detection_yunet_2023mar.onnx": "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
    # OpenCV Zoo SFace face recognition (128-d identity embedding)
    "face_recognition_sface_2021dec.onnx": "https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx",
}

MIN_BYTES = 100_000


def main() -> int:
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    failed = False
    for name, url in MODELS.items():
        target = MODELS_DIR / name
        if target.exists() and target.stat().st_size >= MIN_BYTES:
            print(f"ok      {name} ({target.stat().st_size // 1024} KB, already present)")
            continue
        print(f"fetch   {name}")
        partial = target.with_suffix(target.suffix + ".part")
        try:
            urllib.request.urlretrieve(url, partial)
        except Exception as error:  # noqa: BLE001 - report and continue with the rest
            print(f"FAILED  {name}: {error}")
            failed = True
            continue
        if partial.stat().st_size < MIN_BYTES:
            # Git LFS pointer files are tiny; a real model is not.
            print(f"FAILED  {name}: downloaded file is too small ({partial.stat().st_size} bytes)")
            partial.unlink()
            failed = True
            continue
        partial.rename(target)
        print(f"ok      {name} ({target.stat().st_size // 1024} KB)")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
