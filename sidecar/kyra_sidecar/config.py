import os
from dataclasses import dataclass, field
from pathlib import Path

SIDECAR_ROOT = Path(__file__).resolve().parent.parent


def _number(name: str, default: float) -> float:
    raw = os.environ.get(name, "")
    try:
        return float(raw) if raw.strip() else default
    except ValueError:
        return default


def _flag(name: str, default: bool) -> bool:
    raw = os.environ.get(name, "").strip().lower()
    if not raw:
        return default
    return raw not in ("0", "false", "no", "off")


@dataclass
class Config:
    host: str = field(default_factory=lambda: os.environ.get("SIDECAR_HOST", "127.0.0.1"))
    port: int = field(default_factory=lambda: int(_number("SIDECAR_PORT", 8765)))
    token: str = field(default_factory=lambda: os.environ.get("SIDECAR_TOKEN", ""))
    # Host names requests may be addressed to (besides localhost). Anything else is refused, which stops
    # DNS rebinding: a web page pointing its own domain at 127.0.0.1 to reach the camera.
    allowed_hosts: list[str] = field(default_factory=lambda: [h.strip().lower() for h in os.environ.get("SIDECAR_ALLOWED_HOSTS", "").split(",") if h.strip()])
    # Largest request body (base64 images): bigger requests are refused before they are read.
    max_body_mb: float = field(default_factory=lambda: _number("SIDECAR_MAX_BODY_MB", 32))

    camera_enabled: bool = field(default_factory=lambda: _flag("CAMERA", True))
    camera_index: int = field(default_factory=lambda: int(_number("CAMERA_INDEX", 0)))
    camera_width: int = field(default_factory=lambda: int(_number("CAMERA_WIDTH", 1920)))
    camera_height: int = field(default_factory=lambda: int(_number("CAMERA_HEIGHT", 1080)))
    # Clockwise rotation applied to camera frames (0, 90, 180, 270) for portrait-mounted cameras.
    camera_rotation: int = field(default_factory=lambda: int(_number("CAMERA_ROTATION", 0)))
    # Mirror the preview and captures horizontally, like a real mirror.
    camera_mirror: bool = field(default_factory=lambda: _flag("CAMERA_MIRROR", True))
    analysis_width: int = field(default_factory=lambda: int(_number("ANALYSIS_WIDTH", 960)))
    target_fps: float = field(default_factory=lambda: _number("TARGET_FPS", 15))

    # Auto-capture: how long the visitor must hold a "ready" pose, and how many frames feed skin averaging.
    # 3 s matches the kiosk UI's 3-2-1 countdown (Kyra-UI-V1). The sharpest ready frame is still the one captured.
    ready_hold_ms: int = field(default_factory=lambda: int(_number("READY_HOLD_MS", 3000)))
    skin_frames: int = field(default_factory=lambda: int(_number("SKIN_FRAMES", 15)))
    # Skin measurement: "detector" (vendored undertone detector on face-mesh regions) or "legacy"
    # (the original single cheek/forehead patch).
    undertone_engine: str = field(default_factory=lambda: os.environ.get("UNDERTONE_ENGINE", "detector").strip().lower())
    # Visitor counts as gone after this long with nobody in frame.
    absent_after_ms: int = field(default_factory=lambda: int(_number("ABSENT_AFTER_MS", 30000)))
    capture_ttl_s: int = field(default_factory=lambda: int(_number("CAPTURE_TTL_S", 300)))

    # Hands-free control: a gesture must be held this long, then is ignored for the cooldown.
    gestures: bool = field(default_factory=lambda: _flag("GESTURES", True))
    gesture_hold_ms: int = field(default_factory=lambda: int(_number("GESTURE_HOLD_MS", 600)))
    gesture_cooldown_ms: int = field(default_factory=lambda: int(_number("GESTURE_COOLDOWN_MS", 2000)))
    # Watchdog: reopen the camera when frames stop changing at all for this long (a frozen driver).
    freeze_after_s: float = field(default_factory=lambda: _number("FREEZE_AFTER_S", 5))

    # Finishing renders (/compose). Off by default since 7 Nov 2026: on a webcam capture, where the visitor is
    # small in frame, pasting the real hands left low-resolution skin blocks at the wrists, and matching the
    # body outline squeezed loose garments (sliced sleeves, stepped trouser edges). Turn on for a sharp,
    # close camera.
    compose_hands: bool = field(default_factory=lambda: _flag("COMPOSE_HANDS", False))
    compose_silhouette: bool = field(default_factory=lambda: _flag("COMPOSE_SILHOUETTE", False))

    models_dir: Path = field(default_factory=lambda: Path(os.environ.get("MODELS_DIR", SIDECAR_ROOT / "models")))
    calibration_path: Path = field(
        default_factory=lambda: Path(os.environ.get("CALIBRATION_PATH", SIDECAR_ROOT / "calibration.json"))
    )
