"""The visit's clearest face, picked from the live camera and placed onto the finished render.

The full-body capture decides the body (pose, shape, size, measurements), but its face is small: about 60 px
wide from a webcam at head-to-toe distance. So the camera keeps the clearest view of the face seen during the
visit (largest, sharpest, facing the mirror, eyes open, well lit), usually while the visitor walks up. After
the render comes back, that face is lined up on the render's face with the face mesh, matched to the render's
colour and light, and blended in, inside the face only (the render's hair, ears and neck stay). This runs
locally and costs no tokens. It is applied only when it is safe: both faces must look in roughly the same
direction, and the identity check must agree it is more clearly the visitor afterwards.
"""

from __future__ import annotations

import cv2
import numpy as np

FACE_REF_SIZE = 512
# Mesh points that move little with expression: eye corners, nose bridge and tip, mouth corners, chin, brows.
STABLE_POINTS = [33, 133, 362, 263, 168, 6, 197, 1, 4, 61, 291, 199, 152, 70, 300, 105, 334, 234, 454]
# Inner face outline: brows across the top (so hair is never moved), cheeks and jaw around the rest.
BROWS = [70, 63, 105, 66, 107, 336, 296, 334, 293, 300]
JAW = [234, 93, 132, 58, 172, 136, 150, 149, 176, 148, 152, 377, 400, 378, 379, 365, 397, 288, 361, 323, 454]
LEFT_EYE, RIGHT_EYE = (33, 133, 159, 145), (362, 263, 386, 374)  # corner, corner, upper lid, lower lid
NOSE_TIP = 1

MAX_YAW = 0.35           # how far a face may be turned and still count as facing the mirror
# A coarse guard only: the mesh's own reading of direction varies by ~0.1 for the very same face depending on
# framing (measured 7 Nov 2026). Whether two faces really line up is decided by MAX_FIT_ERROR below.
MAX_POSE_DIFFERENCE = 0.3
MAX_FIT_ERROR = 0.1      # median distance of the lined-up points, in eye distances
MIN_EYE_OPENNESS = 0.16


def head_pose(points: np.ndarray) -> dict:
    """Turn (yaw), nod (pitch) and tilt (roll, degrees) of a face, from its mesh in pixels.

    yaw and pitch are the nose tip's offset from the middle of the eyes, in units of the distance between the
    eyes: 0 is facing straight on. They are only compared between two faces, so their absolute scale is moot."""
    left = points[[LEFT_EYE[0], LEFT_EYE[1]]].mean(axis=0)
    right = points[[RIGHT_EYE[0], RIGHT_EYE[1]]].mean(axis=0)
    eyes = right - left
    between = float(np.linalg.norm(eyes)) or 1.0
    roll = float(np.degrees(np.arctan2(eyes[1], eyes[0])))
    # Measure the nose in the face's own frame, so a tilted head does not read as turned.
    c, s = np.cos(np.radians(-roll)), np.sin(np.radians(-roll))
    nose = points[NOSE_TIP] - (left + right) / 2
    nose = np.array([c * nose[0] - s * nose[1], s * nose[0] + c * nose[1]]) / between
    return {"yaw": float(nose[0]), "pitch": float(nose[1]), "roll": roll, "eyeDistance": between}


def eye_openness(points: np.ndarray) -> float:
    """Smaller of the two eyes' lid gap divided by eye width: about 0.3 open, under 0.15 closed or blinking."""
    ratios = []
    for corner_a, corner_b, upper, lower in (LEFT_EYE, RIGHT_EYE):
        width = float(np.linalg.norm(points[corner_a] - points[corner_b])) or 1.0
        ratios.append(float(np.linalg.norm(points[upper] - points[lower])) / width)
    return min(ratios)


def face_quality(rgb: np.ndarray, points: np.ndarray, face_px: float) -> dict:
    """How good this view of the face is as the visit's face, 0 to about 1. points: (478, 2) mesh in pixels."""
    pose = head_pose(points)
    x0, y0 = np.maximum(points.min(axis=0).astype(int), 0)
    x1, y1 = points.max(axis=0).astype(int)
    region = cv2.cvtColor(rgb[y0:y1, x0:x1], cv2.COLOR_RGB2GRAY) if x1 > x0 and y1 > y0 else None
    if region is None or region.size < 100:
        return {"score": 0.0}
    # Detail: Laplacian variance, normalised so a face of any size compares fairly.
    sharp = float(cv2.Laplacian(cv2.resize(region, (128, 128), interpolation=cv2.INTER_AREA), cv2.CV_64F).var())
    brightness = float(region.mean())
    size = min(face_px, 320.0) / 320.0
    sharpness = min(1.0, sharp / 250.0)
    facing = max(0.0, 1 - abs(pose["yaw"]) / MAX_YAW) * max(0.0, 1 - abs(pose["roll"]) / 25.0)
    eyes = 1.0 if eye_openness(points) >= MIN_EYE_OPENNESS else 0.25
    light = 1.0 if 55 <= brightness <= 215 else 0.5
    score = size * (0.3 + 0.7 * sharpness) * facing * eyes * light
    return {"score": round(score, 4), "facePx": round(face_px, 1), "sharpness": round(sharpness, 3), "facing": round(facing, 3),
            "eyesOpen": eyes == 1.0, "brightness": round(brightness, 1), "pose": {k: round(v, 3) for k, v in pose.items()}}


def crop_face(rgb: np.ndarray, points: np.ndarray, size: int = FACE_REF_SIZE) -> np.ndarray:
    """Square crop around the face with room for hair and chin, resized to size x size."""
    h, w = rgb.shape[:2]
    centre = points.mean(axis=0)
    half = float(np.ptp(points[:, 0])) * 0.9
    x0, y0 = int(max(0, centre[0] - half)), int(max(0, centre[1] - half))
    x1, y1 = int(min(w, centre[0] + half)), int(min(h, centre[1] + half))
    crop = rgb[y0:y1, x0:x1]
    interpolation = cv2.INTER_AREA if crop.shape[0] > size else cv2.INTER_CUBIC
    return cv2.resize(crop, (size, size), interpolation=interpolation)


def _inner_face_mask(points: np.ndarray, shape: tuple[int, int]) -> np.ndarray:
    """Float mask of the inner face: from just above the brows down around the jaw, feathered at the edge."""
    between = head_pose(points)["eyeDistance"]
    brows = points[BROWS].copy()
    brows[:, 1] -= 0.18 * between  # a little forehead above the brows, still below the hairline
    jaw = points[JAW]
    centre = np.vstack([brows, jaw]).mean(axis=0)
    jaw = centre + (jaw - centre) * 0.94  # stay inside the jaw line, off the background and the neck edge
    mask = np.zeros(shape, dtype=np.uint8)
    cv2.fillConvexPoly(mask, cv2.convexHull(np.vstack([brows, jaw]).astype(np.int32)), 255)
    sigma = max(1.5, 0.07 * between)
    mask = cv2.erode(mask, np.ones((3, 3), np.uint8), iterations=max(1, int(sigma)))
    return cv2.GaussianBlur(mask.astype(np.float32) / 255.0, (0, 0), sigma)


def _match_colour(source: np.ndarray, target: np.ndarray, region: np.ndarray) -> np.ndarray:
    """Shifts source's colour and brightness (CIELAB mean and spread inside region) to the target's, so the
    clear face takes on the render's light instead of the room's."""
    src = cv2.cvtColor(source, cv2.COLOR_RGB2LAB).astype(np.float32)
    tgt = cv2.cvtColor(target, cv2.COLOR_RGB2LAB).astype(np.float32)
    for channel in range(3):
        s, t = src[..., channel][region], tgt[..., channel][region]
        if s.size < 50:
            return source
        ratio = float(np.clip(t.std() / max(s.std(), 1e-3), 0.7, 1.4))
        src[..., channel] = (src[..., channel] - s.mean()) * ratio + t.mean()
    return cv2.cvtColor(np.clip(src, 0, 255).astype(np.uint8), cv2.COLOR_LAB2RGB)


def transfer_face(target: np.ndarray, target_points: np.ndarray, source: np.ndarray, source_points: np.ndarray) -> tuple[np.ndarray | None, dict]:
    """Places source's face onto target's. Points are (478, 2) meshes in each image's pixels.
    Returns (image or None, report). None means it was not safe to do."""
    sp, tp = head_pose(source_points), head_pose(target_points)
    report = {"sourcePose": {k: round(v, 3) for k, v in sp.items()}, "targetPose": {k: round(v, 3) for k, v in tp.items()}}
    if abs(sp["yaw"]) > MAX_YAW or abs(tp["yaw"]) > MAX_YAW:
        return None, {**report, "reason": "a face is turned too far"}
    difference = max(abs(sp["yaw"] - tp["yaw"]), abs(sp["pitch"] - tp["pitch"]))
    report["poseDifference"] = round(difference, 3)
    if difference > MAX_POSE_DIFFERENCE:
        return None, {**report, "reason": "the faces look in different directions"}
    if eye_openness(source_points) < MIN_EYE_OPENNESS:
        return None, {**report, "reason": "eyes closed in the close-up"}

    matrix, inliers = cv2.estimateAffinePartial2D(source_points[STABLE_POINTS].astype(np.float32),
                                                  target_points[STABLE_POINTS].astype(np.float32), method=cv2.LMEDS)
    if matrix is None:
        return None, {**report, "reason": "could not line the faces up"}
    scale = float(np.sqrt(abs(np.linalg.det(matrix[:, :2]))))
    report["scale"] = round(scale, 3)
    h, w = target.shape[:2]
    warped = cv2.warpAffine(source, matrix, (w, h), flags=cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC, borderMode=cv2.BORDER_REFLECT)
    moved = cv2.transform(source_points[None].astype(np.float32), matrix)[0]
    error = float(np.median(np.linalg.norm(moved[STABLE_POINTS] - target_points[STABLE_POINTS], axis=1)) / tp["eyeDistance"])
    report["fitError"] = round(error, 3)
    if error > MAX_FIT_ERROR:  # the two faces' shapes do not line up well enough (expression, perspective)
        return None, {**report, "reason": "the faces do not line up"}

    covered = cv2.warpAffine(np.ones(source.shape[:2], np.uint8), matrix, (w, h), flags=cv2.INTER_NEAREST) > 0
    alpha = _inner_face_mask(target_points, (h, w)) * covered
    core = alpha > 0.9
    warped = _match_colour(warped, target, core)
    blended = target.astype(np.float32) * (1 - alpha[..., None]) + warped.astype(np.float32) * alpha[..., None]
    return np.clip(blended, 0, 255).astype(np.uint8), {**report, "reason": "transferred"}
