"""Turns a frame analysis into one instruction for the visitor, in priority order."""

from .perception import FrameAnalysis

MIN_LUMINANCE = 50
MIN_FACE_LUMINANCE = 45
MIN_PIXEL_HEIGHT = 0.5
CENTER_RANGE = (0.3, 0.7)
MAX_MOTION = 0.012
MIN_SHARPNESS = 25.0
# Face size never decides guidance: on a landscape camera a head-to-toe framing leaves the face ~80 px
# wide, so asking for a bigger face fought "step back". A small face is handled downstream instead
# (the sharpest close-up seen on the way in, and keeping the render's face when it passes the identity check).

MESSAGES = {
    "no_person": "Step in front of the mirror",
    "too_dark": "It's a little dark — step into the light",
    "too_close": "Step back so I can see you from head to toe",
    "too_far": "Step a little closer",
    "move_left": "Move a little to your left",
    "move_right": "Move a little to your right",
    "not_standing": "Please stand up straight",
    "face_hidden": "Face the mirror so I can see your face",
    "blurry": "Hold still for a moment",
    "moving": "Hold still…",
    "ready": "Perfect — hold that pose",
}


def evaluate(analysis: FrameAnalysis, motion: float = 0.0, mirrored: bool = True) -> dict:
    state = _state(analysis, motion, mirrored)
    return {"state": state, "message": MESSAGES[state], "ready": state == "ready"}


class GuidanceSmoother:
    """Changes the shown instruction only after the new state has held for `frames` frames, so the
    visitor does not see it flicker and a one-frame blip does not reset the capture countdown."""

    def __init__(self, frames: int = 3):
        self.frames = frames
        self.current: dict | None = None
        self._candidate: str | None = None
        self._count = 0

    def update(self, guidance: dict) -> dict:
        if self.current is None or guidance["state"] == self.current["state"]:
            self.current, self._candidate, self._count = guidance, None, 0
            return self.current
        if guidance["state"] == self._candidate:
            self._count += 1
        else:
            self._candidate, self._count = guidance["state"], 1
        if self._count >= self.frames:
            self.current, self._candidate, self._count = guidance, None, 0
        return self.current


def _state(a: FrameAnalysis, motion: float, mirrored: bool) -> str:
    if not a.present:
        return "no_person"
    if a.luminance < MIN_LUMINANCE or a.extras.get("faceLuminance", 255) < MIN_FACE_LUMINANCE:
        return "too_dark"
    if a.head_cut or a.feet_cut:
        return "too_close"
    if (a.pixel_height or 0) < MIN_PIXEL_HEIGHT:
        return "too_far"
    if a.bbox is not None:
        center = (a.bbox[0] + a.bbox[2]) / 2
        # In a mirrored image the visitor's left is image left; otherwise it is flipped.
        if center < CENTER_RANGE[0]:
            return "move_right" if mirrored else "move_left"
        if center > CENTER_RANGE[1]:
            return "move_left" if mirrored else "move_right"
    if not a.standing:
        return "not_standing"
    if not a.face_visible:
        return "face_hidden"
    if motion > MAX_MOTION:
        return "moving"
    if a.sharpness < MIN_SHARPNESS:
        return "blurry"
    return "ready"
