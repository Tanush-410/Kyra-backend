import logging

import uvicorn

from .config import Config
from .server import create_app


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    config = Config()
    missing = [name for name in ("pose_landmarker_full.task", "face_landmarker.task",
                                 "face_detection_yunet_2023mar.onnx", "face_recognition_sface_2021dec.onnx")
               if not (config.models_dir / name).exists()]
    if missing:
        raise SystemExit(f"Missing models in {config.models_dir}: {', '.join(missing)}. Run scripts/download_models.py")
    uvicorn.run(create_app(config), host=config.host, port=config.port, log_level="info")


if __name__ == "__main__":
    main()
