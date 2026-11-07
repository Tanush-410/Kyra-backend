"""Live camera loop: guidance, multi-frame skin averaging, auto-capture and presence tracking."""

import logging
import sys
import threading
import time
from collections import deque

import cv2
import numpy as np

from .calibration import Calibration
from .capture import build_bundle, jsonable, visitor_profile
from .guidance import GuidanceSmoother, evaluate
from . import lighting, undertone_adapter
from .facetransfer import crop_face, face_quality
from .capture import skin_config
from .perception import (EYE_CORNERS, LEFT_HIP, LEFT_SHOULDER, NOSE, RIGHT_HIP, RIGHT_SHOULDER, Perception,
                         SubjectTracker, face_width_px, skin_sample)

log = logging.getLogger("kyra.camera")

MOTION_POINTS = [NOSE, LEFT_SHOULDER, RIGHT_SHOULDER, LEFT_HIP, RIGHT_HIP]
STATE_HEARTBEAT_S = 1.0
# Early profile: once this many skin frames agree, the profile is sent ahead of the capture so the
# backend can design outfits while the visitor is still getting into position.
EARLY_PROFILE_MIN_FRAMES = 8
EARLY_PROFILE_MIN_INTERVAL_S = 1.5
READY_BUFFER = 12
ROTATIONS = {90: cv2.ROTATE_90_CLOCKWISE, 180: cv2.ROTATE_180, 270: cv2.ROTATE_90_COUNTERCLOCKWISE}


class CameraLoop:
    def __init__(self, config, perception: Perception, calibration: Calibration, publish):
        self.config = config
        self.perception = perception
        self.calibration = calibration
        self.publish = publish  # thread-safe callable(event: dict)

        self.status = "stopped"
        self.error = ""
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._lock = threading.Lock()

        self._latest_frame: np.ndarray | None = None
        self._latest_analysis = None
        self._preview_jpeg: bytes | None = None
        self.state: dict = {"state": "no_person", "message": "", "ready": False}

        self._armed_for: str | None = None
        self._ready_since: float | None = None
        self._ready_frames: deque = deque(maxlen=READY_BUFFER)
        self._skin: deque = deque(maxlen=config.skin_frames)
        self._previous_points: np.ndarray | None = None
        self._motion = 0.0
        self._present = False
        self._last_seen = 0.0
        self._last_state_sent = 0.0
        self._frame_count = 0
        self._gesture_candidate: tuple[str, float] | None = None
        self._gesture_cooldown_until = 0.0
        self._last_thumb: np.ndarray | None = None
        self._unchanged_since: float | None = None
        self.reconnects = 0
        self._early_profile_key = None
        self._early_profile_at = 0.0
        self._smoother = GuidanceSmoother()
        self._best_face: dict | None = None
        self._face_sent_score: float | None = None  # score of the face that went with this visit's capture
        # Multiple people: the nearest one is the subject, tracked across frames.
        self._tracker = SubjectTracker()
        self._subject_id: int | None = None
        # Lighting: the empty room is learned as a reference; the visit's correction is smoothed.
        self._room = lighting.RoomLight()
        self._light = lighting.LightSmoother()

    # ---- control --------------------------------------------------------------------------------

    def start(self) -> None:
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="camera", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=3)

    def arm(self, session_id: str) -> None:
        with self._lock:
            self._armed_for = session_id
            self._ready_since = None
            self._ready_frames.clear()
            self._early_profile_key = None
        self.publish({"type": "armed", "sessionId": session_id})

    def disarm(self) -> None:
        with self._lock:
            self._armed_for = None
        self.publish({"type": "disarmed"})

    @property
    def armed_for(self) -> str | None:
        return self._armed_for

    def latest(self):
        with self._lock:
            return self._latest_frame, self._latest_analysis

    def preview_jpeg(self) -> bytes | None:
        return self._preview_jpeg

    def capture_now(self) -> dict | None:
        """Capture immediately from the latest frame (used by the manual capture endpoint)."""
        with self._lock:
            frame, analysis, skin = self._latest_frame, self._latest_analysis, list(self._skin)
        if frame is None or analysis is None or not analysis.present:
            return None
        return build_bundle(frame, analysis, skin, self.perception, self.calibration, "camera", self.config.camera_mirror)

    # ---- loop -----------------------------------------------------------------------------------

    def _open(self):
        backend = cv2.CAP_AVFOUNDATION if sys.platform == "darwin" else cv2.CAP_ANY
        capture = cv2.VideoCapture(self.config.camera_index, backend)
        capture.set(cv2.CAP_PROP_FRAME_WIDTH, self.config.camera_width)
        capture.set(cv2.CAP_PROP_FRAME_HEIGHT, self.config.camera_height)
        return capture

    def _run(self) -> None:
        """Keeps the camera running: reopens it with backoff if it fails, drops out, or freezes."""
        started = time.monotonic()
        backoff = 1.0
        while not self._stop.is_set():
            capture = self._open()
            if not capture.isOpened():
                self.status, self.error = "error", "Could not open the camera (check camera permission for this app)."
                log.error(self.error)
                self.publish({"type": "camera", "status": self.status, "error": self.error})
                capture.release()
                self._stop.wait(backoff)
                backoff = min(backoff * 2, 30.0)
                continue

            backoff = 1.0
            self.status, self.error = "running", ""
            self.publish({"type": "camera", "status": self.status, "reconnects": self.reconnects})
            reason = self._read_frames(capture, started)
            capture.release()
            if reason and not self._stop.is_set():
                self.reconnects += 1
                self.status, self.error = "reconnecting", reason
                log.warning("Camera %s; reconnecting", reason)
                self.publish({"type": "camera", "status": self.status, "error": reason})
                self._stop.wait(1.0)
        self.status = "stopped"

    def _read_frames(self, capture, started: float) -> str:
        """Reads until stopped (returns "") or the camera misbehaves (returns the reason)."""
        frame_interval = 1.0 / max(1.0, self.config.target_fps)
        failures = 0
        self._last_thumb, self._unchanged_since = None, None
        while not self._stop.is_set():
            tick = time.monotonic()
            ok, bgr = capture.read()
            if not ok or bgr is None:
                failures += 1
                if failures > 50:
                    return "stopped delivering frames"
                time.sleep(0.05)
                continue
            failures = 0
            if self._frozen(bgr, tick):
                return "frozen (identical frames)"
            try:
                self._process(bgr, int((tick - started) * 1000))
            except Exception:  # noqa: BLE001 - keep the loop alive; log and carry on
                log.exception("Frame processing failed")
            time.sleep(max(0.0, frame_interval - (time.monotonic() - tick)))
        return ""

    def _frozen(self, bgr: np.ndarray, now: float) -> bool:
        # Real sensors always have some noise; a stuck driver repeats the exact same buffer.
        thumb = cv2.resize(bgr, (160, 90), interpolation=cv2.INTER_AREA).astype(np.int16)
        if self._last_thumb is not None and np.abs(thumb - self._last_thumb).mean() < 0.01:
            self._unchanged_since = self._unchanged_since or now
        else:
            self._unchanged_since = None
        self._last_thumb = thumb
        return self._unchanged_since is not None and now - self._unchanged_since > self.config.freeze_after_s

    def _process(self, bgr: np.ndarray, timestamp_ms: int) -> None:
        if self.config.camera_rotation in ROTATIONS:
            bgr = cv2.rotate(bgr, ROTATIONS[self.config.camera_rotation])
        if self.config.camera_mirror:
            bgr = cv2.flip(bgr, 1)
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)

        scale = self.config.analysis_width / rgb.shape[1]
        small = cv2.resize(rgb, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) if scale < 1 else rgb
        analysis = self.perception.analyze(small, timestamp_ms, tracker=self._tracker)
        self._room.observe(small, present=analysis.person_count > 0)
        self._track_subject(analysis)
        self._update_motion(analysis)
        face_px = face_width_px(analysis, rgb.shape[1])
        raw = evaluate(analysis, self._motion, self.config.camera_mirror)
        guidance = self._smoother.update(raw)
        now = time.monotonic()
        self._frame_count += 1
        if self.config.gestures and analysis.present and self._frame_count % 2 == 0:
            self._track_gesture(self.perception.gesture(small, timestamp_ms), now)

        self._track_presence(analysis.present or self._face_nearby(small), now)
        # Frames where the subject is briefly lost (and maybe someone else is chosen) are not measured.
        confirmed = analysis.extras.get("subjectConfirmed", True)
        if analysis.present and confirmed and raw["state"] != "too_dark" and analysis.face_visible:
            reference_rgb = self.calibration.reference_rgb(rgb)
            reference_missing = bool(self.calibration.white_balance_roi) and reference_rgb is None
            if self.config.undertone_engine == "legacy":
                gains = self.calibration.white_balance_gains(small)
                sample = None if reference_missing else skin_sample(small, analysis, gains)
            elif self._frame_count % 2 == 1:
                # The undertone detector on the full-resolution face, every other frame to spare the CPU.
                sample = (None if reference_missing else
                          undertone_adapter.measure_frame(rgb, analysis.face_landmarks, analysis.person_mask,
                                                          reference_rgb, skin_config(self.calibration),
                                                          people_mask=analysis.people_mask, room=self._room,
                                                          smoother=self._light, **self.calibration.card_settings()))
            else:
                sample = None
            if sample and "lab" in sample:
                self._skin.append(sample)
            self._track_best_face(rgb, analysis, face_px)

        capture_due = False
        with self._lock:
            self._latest_frame, self._latest_analysis = rgb, analysis
            if guidance["ready"]:
                self._ready_since = self._ready_since or now
                if raw["ready"] and confirmed:  # only genuinely ready frames of the subject can become the capture
                    self._ready_frames.append((analysis.sharpness, rgb, analysis))
            else:
                self._ready_since = None
                self._ready_frames.clear()
            held_ms = (now - self._ready_since) * 1000 if self._ready_since else 0
            if self._armed_for and held_ms >= self.config.ready_hold_ms and self._ready_frames:
                capture_due = True
                session_id = self._armed_for
                _, best_frame, best_analysis = max(self._ready_frames, key=lambda item: item[0])
                skin = list(self._skin)
                # The clearest face of the visit goes with every capture: the render's face is taken from it.
                face_ref = self._best_face
                self._face_sent_score = face_ref["score"] if face_ref else 0.0
                self._armed_for = None

        guidance = {**guidance, "heldMs": int(held_ms), "armed": bool(self._armed_for) or capture_due}
        changed = guidance["state"] != self.state.get("state")
        self.state = guidance
        if changed or now - self._last_state_sent > STATE_HEARTBEAT_S:
            self._last_state_sent = now
            self.publish({"type": "state", **guidance, "skinFrames": len(self._skin)})

        self._preview_jpeg = cv2.imencode(".jpg", cv2.resize(bgr, None, fx=min(1.0, 720 / bgr.shape[1]),
                                                              fy=min(1.0, 720 / bgr.shape[1])),
                                          [cv2.IMWRITE_JPEG_QUALITY, 70])[1].tobytes()

        if not capture_due:
            self._send_early_profile(analysis, now)

        if capture_due:
            bundle = build_bundle(best_frame, best_analysis, skin, self.perception, self.calibration, "camera",
                                  self.config.camera_mirror, face_ref=face_ref)
            bundle["sessionId"] = session_id
            self.publish({"type": "capture", "sessionId": session_id, "bundle": bundle})

    def _track_subject(self, analysis) -> None:
        """When a different person becomes the subject (someone nearer stepped in), the previous person's skin
        samples, face close-up and lighting estimate are dropped so the two are never mixed."""
        subject_id = analysis.extras.get("subjectId")
        if subject_id is None or subject_id == self._subject_id:
            return
        replaced = self._subject_id is not None and self._present
        self._subject_id = subject_id
        self._skin.clear()
        self._best_face = None
        self._face_sent_score = None
        self._light.reset()
        with self._lock:
            self._ready_since = None
            self._ready_frames.clear()
            self._early_profile_key = None
        if replaced:
            self.publish({"type": "subject", "subjectId": subject_id, "replaced": True})

    def _track_best_face(self, rgb: np.ndarray, analysis, face_px: float | None) -> None:
        """Keeps the clearest view of the face seen this visit (largest, sharpest, facing the mirror, eyes open,
        well lit), usually while the visitor walks up. The render's face is taken from it (facetransfer.py).
        After a capture, a clearly better view (25% higher score) is announced so the look can be updated."""
        if not face_px or analysis.face_landmarks is None:
            return
        h, w = rgb.shape[:2]
        points = analysis.face_landmarks * [w, h]
        quality = face_quality(rgb, points, face_px)
        if quality["score"] <= 0 or (self._best_face and quality["score"] <= self._best_face["score"]):
            return
        self._best_face = {"image": crop_face(rgb, points), "facePx": face_px, "score": quality["score"], "quality": quality}
        sent = getattr(self, "_face_sent_score", None)
        if sent is not None and quality["score"] > max(sent, 1e-6) * 1.25:
            self._face_sent_score = quality["score"]
            self.publish({"type": "face", "better": True, "score": quality["score"], "facePx": round(face_px, 1)})

    def best_face(self) -> dict | None:
        """The clearest face of this visit so far (image, facePx, score, quality), or None."""
        return self._best_face

    def _send_early_profile(self, analysis, now: float) -> None:
        """While armed, sends the visitor's profile once it is stable, and again only if it changes.

        Skin needs only the face, so this starts while the visitor is still too close for a head-to-toe
        capture; the mirror shows the undertone straight away. Unsure readings are sent too (the mirror
        says it is still reading), and a later, surer reading replaces them."""
        session_id = self._armed_for
        if not session_id or not analysis.present or len(self._skin) < EARLY_PROFILE_MIN_FRAMES:
            return
        if now - self._early_profile_at < EARLY_PROFILE_MIN_INTERVAL_S:
            return
        profile = visitor_profile(analysis, list(self._skin), self.calibration)
        skin = profile["skin"]
        if not skin:
            return
        cm = profile["height"]["cm"]
        key = (skin["skinUndertone"], skin["skinDepth"], skin["confidence"], round(cm / 5) if cm else None,
               (profile["frame"] or {}).get("build"))
        if key == self._early_profile_key:
            return
        self._early_profile_key, self._early_profile_at = key, now
        self.publish({"type": "profile", "sessionId": session_id, "profile": jsonable(profile)})

    def _track_gesture(self, gesture: tuple[str, float] | None, now: float) -> None:
        """Emits a gesture once it has been held for gesture_hold_ms, then waits out the cooldown."""
        if gesture is None or gesture[1] < 0.7 or now < self._gesture_cooldown_until:
            self._gesture_candidate = None
            return
        name = gesture[0]
        if self._gesture_candidate is None or self._gesture_candidate[0] != name:
            self._gesture_candidate = (name, now)
            return
        if (now - self._gesture_candidate[1]) * 1000 >= self.config.gesture_hold_ms:
            self.publish({"type": "gesture", "gesture": name, "score": round(gesture[1], 3), "sessionId": self._armed_for})
            self._gesture_candidate = None
            self._gesture_cooldown_until = now + self.config.gesture_cooldown_ms / 1000

    def _update_motion(self, analysis) -> None:
        if not analysis.present:
            self._previous_points, self._motion = None, 0.0
            return
        points = analysis.landmarks[MOTION_POINTS, :2]
        if self._previous_points is not None:
            displacement = float(np.linalg.norm(points - self._previous_points, axis=1).mean())
            self._motion = 0.6 * self._motion + 0.4 * displacement
        self._previous_points = points

    def _track_presence(self, present: bool, now: float) -> None:
        if present:
            self._last_seen = now
            if not self._present:
                self._present = True
                self._skin.clear()
                self._best_face = None
                self._face_sent_score = None
                self._light.reset()
                self.publish({"type": "presence", "present": True})
        elif self._present and (now - self._last_seen) * 1000 > self.config.absent_after_ms:
            self._present = False
            self._skin.clear()
            self._best_face = None
            self._face_sent_score = None
            self._tracker.reset()  # whoever appears next is a new visitor
            self.publish({"type": "presence", "present": False})

    def _face_nearby(self, small: np.ndarray) -> bool:
        """A visitor standing close to the screen (to look at their result) may show only head and shoulders,
        which the body-pose model can miss. A detected face still counts as someone there. Checked every
        third frame when there is no pose, and remembered in between."""
        if self._frame_count % 3 == 0:
            try:
                self._face_seen = self.perception.face_present(small)
            except Exception:  # noqa: BLE001 - presence must never break the loop
                self._face_seen = False
        return getattr(self, "_face_seen", False)
