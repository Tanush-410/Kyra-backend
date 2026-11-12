"""Which way up the camera is mounted, worked out from a face in view.

The camera's frames are turned by CAMERA_ROTATION (clockwise: 0, 90, 180, 270) before anything uses them.
A camera mounted on its side needs 90 or 270, and which one depends on the direction it was turned, which
is easy to get backwards. So this tries the current frame at all four angles and reports the one in which a
face is upright (found by the face detector, eyes above mouth).
"""
import cv2
import numpy as np

ROTATE = {90: cv2.ROTATE_90_CLOCKWISE, 180: cv2.ROTATE_180, 270: cv2.ROTATE_90_COUNTERCLOCKWISE}
MIN_SCORE = 0.6  # detector confidence needed to trust an answer
MAX_SIDE = 640


def upright_face_score(bgr: np.ndarray, detector) -> float:
    """The best confidence of a face that is the right way up in this image (0 when there is none)."""
    h, w = bgr.shape[:2]
    detector.setInputSize((w, h))
    _, faces = detector.detect(bgr)
    best = 0.0
    for face in faces if faces is not None else []:
        # YuNet rows: box (4), right eye, left eye, nose, right mouth corner, left mouth corner (x, y each), score.
        eyes_y = (face[5] + face[7]) / 2
        mouth_y = (face[11] + face[13]) / 2
        if mouth_y > eyes_y:  # image y grows downwards: upright means the mouth is below the eyes
            best = max(best, float(face[14]))
    return best


def suggest_rotation(frame_bgr: np.ndarray, current: int, mirrored: bool, detector) -> dict:
    """frame_bgr: a frame as the camera loop produces it (already turned by `current`, then mirrored when
    `mirrored`). Returns the CAMERA_ROTATION that makes faces upright, or found=False with no clear face."""
    # Undo the mirror first: a mirror reverses the direction of a quarter turn, so the angles below would
    # come out backwards. Turning the unmirrored frame by `extra` gives rotation (current + extra).
    image = cv2.flip(frame_bgr, 1) if mirrored else frame_bgr
    scale = MAX_SIDE / max(image.shape[:2])
    if scale < 1:
        image = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    scores = {extra: upright_face_score(image if extra == 0 else cv2.rotate(image, ROTATE[extra]), detector)
              for extra in (0, 90, 180, 270)}
    extra = max(scores, key=scores.get)
    by_setting = {str((current + e) % 360): round(s, 3) for e, s in scores.items()}
    if scores[extra] < MIN_SCORE:
        return {"found": False, "current": current, "scores": by_setting,
                "message": "No clear face in view: stand facing the camera, about 1-2 m away, and try again."}
    suggested = (current + extra) % 360
    return {
        "found": True,
        "current": current,
        "suggested": suggested,
        "correct": suggested == current,
        "scores": by_setting,
        "message": ("The camera's rotation is right." if suggested == current
                    else f"The camera is turned: set CAMERA_ROTATION={suggested} and restart."),
    }
