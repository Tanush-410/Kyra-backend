"""On-device perception: pose, face mesh, person/head masks, skin samples, identity embeddings."""

import threading
from dataclasses import dataclass, field

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks.python import BaseOptions, vision

from .color import gray_world_gains, skin_pixel_mask, srgb_to_lab

NOSE, LEFT_EYE_CENTRE, RIGHT_EYE_CENTRE, LEFT_EAR, RIGHT_EAR = 0, 2, 5, 7, 8
LEFT_SHOULDER, RIGHT_SHOULDER, LEFT_HIP, RIGHT_HIP = 11, 12, 23, 24
LEFT_ANKLE, RIGHT_ANKLE = 27, 28
FOOT_POINTS = (29, 30, 31, 32)

FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148,
             176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109]
FACE_LEFT_EDGE, FACE_RIGHT_EDGE, CHIN = 234, 454, 152
# Forehead centre and four cheek points: skin areas clear of eyes, brows, lips and hairline.
SKIN_POINTS = (151, 50, 280, 205, 425)

VISIBLE = 0.5
MIN_SKIN_PIXELS = 60
MESH_NOSE_TIP = 1


@dataclass
class FrameAnalysis:
    width: int
    height: int
    person_count: int = 0
    landmarks: np.ndarray | None = None  # (33, 4) normalized x, y, z, visibility
    world_landmarks: np.ndarray | None = None  # (33, 3) metres, hip-centred
    person_mask: np.ndarray | None = None  # (H, W) float 0-1 for the subject (the nearest person)
    people_mask: np.ndarray | None = None  # (H, W) float 0-1, every detected person (kept out of light estimates)
    bbox: tuple[float, float, float, float] | None = None  # normalized x0, y0, x1, y1
    head_top_y: float | None = None
    foot_y: float | None = None
    head_cut: bool = False
    feet_cut: bool = False
    face_landmarks: np.ndarray | None = None  # (478, 2) normalized
    luminance: float = 0.0
    contrast: float = 0.0
    sharpness: float = 0.0
    second_person_ratio: float = 0.0  # next-nearest person's body size relative to the subject's
    extras: dict = field(default_factory=dict)

    @property
    def present(self) -> bool:
        return self.person_count > 0 and self.landmarks is not None

    @property
    def pixel_height(self) -> float | None:
        if self.head_top_y is None or self.foot_y is None:
            return None
        return max(0.0, self.foot_y - self.head_top_y)

    @property
    def full_body(self) -> bool:
        return self.present and not self.head_cut and not self.feet_cut

    @property
    def standing(self) -> bool:
        """Hip-to-ankle drop clearly longer than shoulder-to-hip: rules out sitting and crouching."""
        if self.landmarks is None:
            return False
        lms = self.landmarks
        shoulder_y = (lms[LEFT_SHOULDER][1] + lms[RIGHT_SHOULDER][1]) / 2
        hip_y = (lms[LEFT_HIP][1] + lms[RIGHT_HIP][1]) / 2
        ankle_y = (lms[LEFT_ANKLE][1] + lms[RIGHT_ANKLE][1]) / 2
        return (ankle_y - hip_y) > 1.1 * (hip_y - shoulder_y) > 0

    @property
    def face_visible(self) -> bool:
        return self.face_landmarks is not None


class Perception:
    def __init__(self, models_dir, live: bool = True):
        pose_path = str(models_dir / "pose_landmarker_full.task")
        face_path = str(models_dir / "face_landmarker.task")
        self._image_lock = threading.Lock()
        self._video_lock = threading.Lock()
        self._face_id_lock = threading.Lock()

        self._face_lock = threading.Lock()
        self._pose_image = vision.PoseLandmarker.create_from_options(
            vision.PoseLandmarkerOptions(base_options=BaseOptions(model_asset_path=pose_path), num_poses=3,
                                         output_segmentation_masks=True)
        )
        # The face mesh runs on an upscaled head crop: its detector is short-range and misses the small
        # faces of a full-body shot, and crops change every frame, so it always runs in IMAGE mode. Two faces,
        # because a crop around one person's head can also hold a neighbour's face; the one on this person's
        # nose is kept.
        self._face_image = vision.FaceLandmarker.create_from_options(
            vision.FaceLandmarkerOptions(base_options=BaseOptions(model_asset_path=face_path), num_faces=2)
        )
        self._pose_video = None
        self._gestures = None
        gesture_path = models_dir / "gesture_recognizer.task"
        if live and gesture_path.exists():
            self._gestures = vision.GestureRecognizer.create_from_options(
                vision.GestureRecognizerOptions(base_options=BaseOptions(model_asset_path=str(gesture_path)),
                                                running_mode=vision.RunningMode.VIDEO, num_hands=2)
            )
        if live:
            self._pose_video = vision.PoseLandmarker.create_from_options(
                vision.PoseLandmarkerOptions(base_options=BaseOptions(model_asset_path=pose_path),
                                             running_mode=vision.RunningMode.VIDEO, num_poses=3,
                                             output_segmentation_masks=True)
            )

        self._face_detector = cv2.FaceDetectorYN.create(
            str(models_dir / "face_detection_yunet_2023mar.onnx"), "", (320, 320), 0.8, 0.3, 5000
        )
        self._face_recognizer = cv2.FaceRecognizerSF.create(str(models_dir / "face_recognition_sface_2021dec.onnx"), "")

    # ---- per-frame analysis -------------------------------------------------------------------

    def analyze(self, rgb: np.ndarray, timestamp_ms: int | None = None,
                tracker: "SubjectTracker | None" = None) -> FrameAnalysis:
        """Analyze an RGB uint8 frame. Pass timestamp_ms for the live (tracking) models, and the live camera's
        tracker so the same visitor stays the subject from frame to frame."""
        image = mp.Image(mp.ImageFormat.SRGB, np.ascontiguousarray(rgb))
        if timestamp_ms is None:
            with self._image_lock:
                pose = self._pose_image.detect(image)
        else:
            with self._video_lock:
                pose = self._pose_video.detect_for_video(image, timestamp_ms)
        return build_analysis(rgb, pose, self._face_in_head_crop, tracker)

    def _face_in_head_crop(self, rgb: np.ndarray, pose_landmarks: np.ndarray) -> np.ndarray | None:
        """Face mesh (478, 2) in full-frame normalized coordinates, found in a crop around the pose head."""
        h, w = rgb.shape[:2]
        head = pose_landmarks[[NOSE, LEFT_EAR, RIGHT_EAR, LEFT_SHOULDER, RIGHT_SHOULDER]][:, :2] * [w, h]
        cx, cy = head[:3].mean(axis=0)
        ear_span = float(np.linalg.norm(head[1] - head[2]))
        shoulder_span = float(np.linalg.norm(head[3] - head[4]))
        size = max(ear_span * 3.2, shoulder_span * 1.1, 48.0)
        x0, y0 = int(max(0, cx - size / 2)), int(max(0, cy - size / 2))
        x1, y1 = int(min(w, cx + size / 2)), int(min(h, cy + size / 2))
        if x1 - x0 < 16 or y1 - y0 < 16:
            return None
        crop = rgb[y0:y1, x0:x1]
        scale = 256.0 / max(crop.shape[:2])
        if scale > 1:
            crop = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
        with self._face_lock:
            result = self._face_image.detect(mp.Image(mp.ImageFormat.SRGB, np.ascontiguousarray(crop)))
        if not result.face_landmarks:
            return None
        faces = [np.array([[lm.x, lm.y] for lm in face]) for face in result.face_landmarks]
        faces = [np.column_stack([(x0 + f[:, 0] * (x1 - x0)) / w, (y0 + f[:, 1] * (y1 - y0)) / h]) for f in faces]
        return closest_face(faces, pose_landmarks[NOSE][:2], max(ear_span, shoulder_span * 0.4) / max(w, h))

    def gesture(self, rgb: np.ndarray, timestamp_ms: int) -> tuple[str, float] | None:
        """Strongest recognised hand gesture in a live frame, e.g. ("thumb_up", 0.91)."""
        if self._gestures is None:
            return None
        result = self._gestures.recognize_for_video(mp.Image(mp.ImageFormat.SRGB, np.ascontiguousarray(rgb)), timestamp_ms)
        best = None
        for categories in result.gestures or []:
            top = categories[0]
            if top.category_name and top.category_name != "None" and (best is None or top.score > best[1]):
                best = (top.category_name.lower(), float(top.score))
        return best

    def face_present(self, rgb: np.ndarray, min_score: float = 0.8) -> bool:
        """Whether any face is in view (YuNet detector only; cheap). Used for presence when the body
        is too close to the camera for the pose model."""
        bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        h, w = bgr.shape[:2]
        with self._face_id_lock:
            self._face_detector.setInputSize((w, h))
            _, faces = self._face_detector.detect(bgr)
        return faces is not None and any(float(face[14]) >= min_score for face in faces)

    # ---- identity -----------------------------------------------------------------------------

    def face_identity(self, rgb: np.ndarray) -> dict | None:
        """Largest face: 128-d SFace embedding plus its normalized box."""
        bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        h, w = bgr.shape[:2]
        with self._face_id_lock:
            self._face_detector.setInputSize((w, h))
            _, faces = self._face_detector.detect(bgr)
            if faces is None or len(faces) == 0:
                return None
            face = max(faces, key=lambda f: f[2] * f[3])
            aligned = self._face_recognizer.alignCrop(bgr, face)
            embedding = self._face_recognizer.feature(aligned).flatten().astype(np.float64)
        x, y, fw, fh = (float(v) for v in face[:4])
        return {
            "embedding": embedding / (np.linalg.norm(embedding) + 1e-9),
            "box": {"x": x / w, "y": y / h, "width": fw / w, "height": fh / h},
            "score": float(face[14]),
        }


def closest_face(faces: list[np.ndarray], nose: np.ndarray, tolerance: float) -> np.ndarray | None:
    """The face mesh whose nose tip is on this person's pose nose (normalized coordinates). A face further than
    `tolerance` from it belongs to someone else, so None."""
    if not faces:
        return None
    distances = [float(np.linalg.norm(face[MESH_NOSE_TIP] - nose)) for face in faces]
    best = int(np.argmin(distances))
    return faces[best] if distances[best] <= max(tolerance, 0.02) else None


def describe_person(lms: np.ndarray, width: int, height: int) -> dict:
    """How near one detected person is: apparent body size (larger is nearer), facing the mirror, centred.

    Body size uses whichever of shoulder width, torso length and head width is largest after scaling to a
    common unit (typical adult proportions): turning or leaning only ever shrinks a span, so the largest is
    the least foreshortened. Sizes are fractions of the frame's longer side."""
    pts = lms[:, :2] * [width, height]
    vis = lms[:, 3]
    longest = float(max(width, height))

    def seen(*indices):
        return all(vis[i] >= VISIBLE for i in indices)

    sizes = []
    if seen(LEFT_SHOULDER, RIGHT_SHOULDER):
        sizes.append(np.linalg.norm(pts[LEFT_SHOULDER] - pts[RIGHT_SHOULDER]))
    if seen(LEFT_SHOULDER, RIGHT_SHOULDER, LEFT_HIP, RIGHT_HIP):
        torso = (pts[LEFT_SHOULDER] + pts[RIGHT_SHOULDER]) / 2 - (pts[LEFT_HIP] + pts[RIGHT_HIP]) / 2
        sizes.append(0.78 * np.linalg.norm(torso))
    if seen(LEFT_EAR, RIGHT_EAR):
        sizes.append(2.6 * np.linalg.norm(pts[LEFT_EAR] - pts[RIGHT_EAR]))
    visible = pts[vis >= VISIBLE] if (vis >= VISIBLE).sum() >= 2 else pts
    if not sizes:
        sizes.append(0.2 * float(np.linalg.norm(visible.max(axis=0) - visible.min(axis=0))))
    scale = float(max(sizes)) / longest

    if seen(LEFT_SHOULDER, RIGHT_SHOULDER):
        centre = (lms[LEFT_SHOULDER, :2] + lms[RIGHT_SHOULDER, :2]) / 2
    elif seen(NOSE):
        centre = lms[NOSE, :2]
    else:
        centre = (visible / [width, height]).mean(axis=0)
    facing = 1.0 if seen(NOSE, LEFT_EYE_CENTRE, RIGHT_EYE_CENTRE) else 0.75
    centred = 1.0 - 0.3 * min(1.0, abs(float(centre[0]) - 0.5) / 0.5)
    return {"scale": scale, "score": scale * facing * centred, "centre": np.asarray(centre, dtype=np.float64)}


class SubjectTracker:
    """Keeps the nearest person as the subject from frame to frame, so a visit's samples come from one person.

    The nearest (largest, facing, centred) person becomes the subject. The subject only ever changes when
    someone else is in view at the same time: when they are clearly nearer (by `margin`) for `switch_frames`
    frames in a row, or the subject has gone for more than `grace_frames` while others remain. One person on
    their own is always the same visitor, however they move: walking up to the screen, stepping back, or
    briefly dropping out of the pose model's view. A new visitor after the scene has been empty is handled by
    `reset()` (the camera calls it when presence ends). `subject_id` changes only on such a handover.
    """

    def __init__(self, switch_frames: int = 5, margin: float = 1.25, grace_frames: int = 8, crowd_memory: int = 45):
        self.switch_frames = switch_frames
        self.margin = margin
        self.grace_frames = grace_frames
        self.crowd_memory = crowd_memory  # frames (about 3 s) for which "someone else was here" is remembered
        self.subject_id = 0
        self._centre: np.ndarray | None = None
        self._scale = 0.0
        self._challenger_frames = 0
        self._missing = 0
        self._since_crowd = crowd_memory

    def reset(self) -> None:
        """The scene has been empty long enough that whoever appears next is a new visitor."""
        self._centre, self._scale = None, 0.0
        self._challenger_frames = self._missing = 0
        self._since_crowd = self.crowd_memory

    def no_people(self) -> None:
        self._missing += 1  # the same visitor may reappear; only reset() forgets them
        self._since_crowd += 1

    def choose(self, people: list[dict]) -> tuple[int, bool]:
        """Index of the subject among this frame's people, and whether it is the confirmed subject."""
        self._since_crowd = 0 if len(people) > 1 else self._since_crowd + 1
        best = max(range(len(people)), key=lambda i: people[i]["score"])
        if self._centre is None:
            return self._adopt(people, best), True
        if len(people) == 1 and self._since_crowd > self.crowd_memory:
            # Alone in view, and nobody else has been around: it is the visitor, wherever they moved (walking
            # up to the screen, stepping back, dropping out of the pose model for a moment). Never a handover.
            self._missing = self._challenger_frames = 0
            self._anchor(people[0])
            return 0, True
        incumbent = self._match(people)
        if incumbent is None:
            self._missing += 1
            if self._missing > self.grace_frames:
                return self._adopt(people, best), True
            return best, False
        self._missing = 0
        if best != incumbent and people[best]["score"] > self.margin * people[incumbent]["score"]:
            self._challenger_frames += 1
            if self._challenger_frames >= self.switch_frames:
                return self._adopt(people, best), True
        else:
            self._challenger_frames = 0
        self._follow(people[incumbent])
        return incumbent, True

    def _match(self, people: list[dict]) -> int | None:
        """The person standing nearest where the subject was. Size may change a lot (walking up to the
        screen doubles it), so it only rules out someone wildly different."""
        tolerance = max(0.1, 1.5 * self._scale)
        best, best_distance = None, tolerance
        for i, person in enumerate(people):
            distance = float(np.linalg.norm(person["centre"] - self._centre))
            size_ratio = person["scale"] / max(self._scale, 1e-6)
            if distance <= best_distance and 0.35 <= size_ratio <= 3.0:
                best, best_distance = i, distance
        return best

    def _anchor(self, person: dict) -> None:
        self._centre, self._scale = person["centre"].copy(), person["scale"]

    def _adopt(self, people: list[dict], index: int) -> int:
        self.subject_id += 1
        self._centre, self._scale = people[index]["centre"].copy(), people[index]["scale"]
        self._challenger_frames = self._missing = 0
        return index

    def _follow(self, person: dict) -> None:
        self._centre = 0.5 * self._centre + 0.5 * person["centre"]
        self._scale = 0.7 * self._scale + 0.3 * person["scale"]


def distinct_people(people: list[np.ndarray], candidates: list[dict], max_overlap: float = 0.45) -> list[int]:
    """Indices of detections that are different people: a detection whose visible-landmark box overlaps a
    stronger one by more than max_overlap (intersection over union) is the same body reported twice."""
    def box(lms):
        visible = lms[lms[:, 3] >= VISIBLE][:, :2]
        points = visible if len(visible) >= 3 else lms[:, :2]
        return (*points.min(axis=0), *points.max(axis=0))

    def overlap(a, b):
        ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
        iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
        inter = ix * iy
        union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
        return inter / union if union > 0 else 0.0

    boxes = [box(lms) for lms in people]
    kept: list[int] = []
    for i in sorted(range(len(people)), key=lambda k: -candidates[k]["score"]):
        if all(overlap(boxes[i], boxes[j]) <= max_overlap for j in kept):
            kept.append(i)
    return sorted(kept)


def build_analysis(rgb: np.ndarray, pose, find_face, tracker: SubjectTracker | None = None) -> FrameAnalysis:
    h, w = rgb.shape[:2]
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    analysis = FrameAnalysis(width=w, height=h, luminance=float(gray.mean()), contrast=float(gray.std()))

    poses = pose.pose_landmarks or []
    analysis.person_count = len(poses)
    if not poses:
        if tracker is not None:
            tracker.no_people()
        return analysis

    masks = [m.numpy_view().squeeze().astype(np.float32) for m in (pose.segmentation_masks or [])]
    people = [np.array([[lm.x, lm.y, lm.z, lm.visibility or 0.0] for lm in person]) for person in poses]
    candidates = [describe_person(lms, w, h) for lms in people]
    # The pose model sometimes reports one body twice (seen live on 7 Nov 2026: 3 frames in 96, the
    # "second person" the same size as the first). Overlapping detections are one person.
    kept = distinct_people(people, candidates)
    if len(kept) < len(people):
        world = pose.pose_world_landmarks or []
        pose = type("Pose", (), {"pose_world_landmarks": [world[i] for i in kept] if world else None})()
        masks = [masks[i] for i in kept] if len(masks) == len(people) else masks
        poses = [poses[i] for i in kept]
        people = [people[i] for i in kept]
        candidates = [candidates[i] for i in kept]
        analysis.person_count = len(kept)
    # The subject is the nearest person; the face mesh then runs on that person only.
    if tracker is None:
        subject, confirmed = int(np.argmax([c["score"] for c in candidates])), True
    else:
        subject, confirmed = tracker.choose(candidates)
        analysis.extras["subjectId"] = tracker.subject_id
    analysis.extras["subjectConfirmed"] = confirmed
    if len(candidates) > 1:
        nearest_other = max(c["scale"] for i, c in enumerate(candidates) if i != subject)
        analysis.second_person_ratio = float(nearest_other / max(candidates[subject]["scale"], 1e-6))

    analysis.landmarks = people[subject]
    if pose.pose_world_landmarks:
        analysis.world_landmarks = np.array([[lm.x, lm.y, lm.z] for lm in pose.pose_world_landmarks[subject]])
    if subject < len(masks):
        analysis.person_mask = masks[subject]
    if masks:
        analysis.people_mask = np.maximum.reduce(masks)

    _measure_extent(analysis)
    if analysis.landmarks[NOSE][3] >= VISIBLE:
        analysis.face_landmarks = find_face(rgb, analysis.landmarks)

    x0, y0, x1, y1 = analysis.bbox or _landmark_box(poses[subject])
    crop = gray[int(max(0, y0) * h):int(min(1, y1) * h), int(max(0, x0) * w):int(min(1, x1) * w)]
    if crop.size:
        analysis.luminance = float(crop.mean())
        analysis.contrast = float(crop.std())
    if analysis.face_landmarks is not None:
        fx0, fy0 = analysis.face_landmarks.min(axis=0)
        fx1, fy1 = analysis.face_landmarks.max(axis=0)
        face_crop = gray[int(max(0, fy0) * h):int(min(1, fy1) * h), int(max(0, fx0) * w):int(min(1, fx1) * w)]
        if face_crop.size:
            analysis.sharpness = float(cv2.Laplacian(face_crop, cv2.CV_64F).var())
            analysis.extras["faceLuminance"] = float(face_crop.mean())
    return analysis


def _landmark_box(landmarks) -> tuple[float, float, float, float]:
    xs = [lm.x for lm in landmarks]
    ys = [lm.y for lm in landmarks]
    return min(xs), min(ys), max(xs), max(ys)


def _measure_extent(analysis: FrameAnalysis) -> None:
    """Head top from the person mask, feet from the heel/toe landmarks."""
    lms = analysis.landmarks
    mask = analysis.person_mask
    h, w = analysis.height, analysis.width

    if mask is not None:
        binary = mask > 0.5
        rows = np.where(binary.any(axis=1))[0]
        cols = np.where(binary.any(axis=0))[0]
        if len(rows) and len(cols):
            analysis.bbox = (cols[0] / w, rows[0] / h, (cols[-1] + 1) / w, (rows[-1] + 1) / h)
            # Topmost person pixel in the columns around the head, so a raised arm is not mistaken for the head.
            ear_xs = [lms[i][0] for i in (LEFT_EAR, RIGHT_EAR, NOSE)]
            head_half = max(0.03, (max(ear_xs) - min(ear_xs)))
            c0 = int(max(0, (min(ear_xs) - head_half) * w))
            c1 = int(min(w, (max(ear_xs) + head_half) * w))
            head_rows = np.where(binary[:, c0:c1].any(axis=1))[0] if c1 > c0 else []
            if len(head_rows):
                analysis.head_top_y = head_rows[0] / h
    if analysis.head_top_y is None:
        neck = abs(lms[LEFT_SHOULDER][1] - lms[NOSE][1])
        analysis.head_top_y = max(0.0, lms[NOSE][1] - 0.9 * neck)

    feet = [lms[i] for i in FOOT_POINTS]
    analysis.foot_y = float(max(p[1] for p in feet))
    analysis.head_cut = analysis.head_top_y <= 0.01 or lms[NOSE][3] < VISIBLE
    feet_visible = all(lms[i][3] >= VISIBLE for i in (LEFT_ANKLE, RIGHT_ANKLE))
    analysis.feet_cut = (not feet_visible) or analysis.foot_y >= 0.985



# ---- derived measurements --------------------------------------------------------------------

def skin_sample(rgb: np.ndarray, analysis: FrameAnalysis, gains: np.ndarray | None) -> dict | None:
    """Median CIELAB of white-balanced skin pixels on the forehead and cheeks of one frame."""
    if analysis.face_landmarks is None:
        return None
    h, w = rgb.shape[:2]
    points = analysis.face_landmarks * [w, h]
    face_width = float(np.linalg.norm(points[FACE_LEFT_EDGE] - points[FACE_RIGHT_EDGE]))
    radius = max(2, int(face_width * 0.07))

    patch_mask = np.zeros((h, w), dtype=np.uint8)
    for index in SKIN_POINTS:
        cx, cy = points[index]
        cv2.circle(patch_mask, (int(cx), int(cy)), radius, 1, -1)

    if gains is None:
        everyone = analysis.people_mask if analysis.people_mask is not None else analysis.person_mask
        exclude = everyone > 0.5 if everyone is not None else None
        gains = gray_world_gains(rgb, exclude)
        method = "gray-world"
    else:
        method = "calibrated"

    pixels = np.clip(rgb[patch_mask.astype(bool)].astype(np.float64) * gains, 0, 255)
    pixels = pixels[skin_pixel_mask(pixels)]
    if len(pixels) < MIN_SKIN_PIXELS:
        return None
    lab = np.median(srgb_to_lab(pixels), axis=0)
    return {"lab": lab, "count": int(len(pixels)), "whiteBalance": method, "gains": gains}


def body_frame(analysis: FrameAnalysis) -> dict | None:
    """Shoulder width relative to shoulder-to-ankle length, from metric world landmarks.

    Thresholds are heuristic: tune them against a few people at the installation.
    """
    world = analysis.world_landmarks
    if world is None or not analysis.full_body or not analysis.standing:
        return None
    shoulder_width = float(np.linalg.norm(world[LEFT_SHOULDER] - world[RIGHT_SHOULDER]))
    hip_width = float(np.linalg.norm(world[LEFT_HIP] - world[RIGHT_HIP]))
    mid_shoulder = (world[LEFT_SHOULDER] + world[RIGHT_SHOULDER]) / 2
    mid_ankle = (world[LEFT_ANKLE] + world[RIGHT_ANKLE]) / 2
    length = float(np.linalg.norm(mid_shoulder - mid_ankle))
    if length < 0.3:
        return None
    ratio = shoulder_width / length
    build = "slim" if ratio < 0.24 else "broad" if ratio > 0.3 else "medium"
    return {"build": build, "shoulderToLength": round(ratio, 3), "shoulderToHip": round(shoulder_width / max(hip_width, 1e-3), 3)}


EYE_CORNERS = (33, 263)


def head_mask(analysis: FrameAnalysis, width: int, height: int, person: np.ndarray | None) -> np.ndarray:
    """Face and hair only, at width x height. uint8 0/255.

    The face oval (grown slightly so the jaw line blends) plus the person's pixels above the eye line
    around the head, i.e. the hair. The neck and collar are left to the render, so pieces of the old
    shirt never get pasted back. person is a uint8 0-255 person mask at the same size, or None.
    """
    mask = np.zeros((height, width), dtype=np.uint8)
    if analysis.face_landmarks is None:
        return mask
    points = (analysis.face_landmarks * [width, height]).astype(np.int32)
    cv2.fillConvexPoly(mask, cv2.convexHull(points[FACE_OVAL]), 255)
    x0, x1 = points[:, 0].min(), points[:, 0].max()
    grow = max(3, int((x1 - x0) * 0.06))
    mask = cv2.dilate(mask, np.ones((grow, grow), np.uint8))
    if person is None:
        return mask

    margin = int((x1 - x0) * 0.35)
    eye_y = int(points[list(EYE_CORNERS), 1].mean())
    region = np.zeros_like(mask)
    region[:max(0, eye_y), max(0, x0 - margin):min(width, x1 + margin)] = 255
    return np.maximum(mask, np.where(person > 127, region, 0).astype(np.uint8))


def face_width_px(analysis: FrameAnalysis, frame_width: int) -> float | None:
    """Width of the face in pixels of a frame frame_width wide (landmarks are normalized)."""
    if analysis.face_landmarks is None:
        return None
    return float(np.ptp(analysis.face_landmarks[:, 0]) * frame_width)


# Pose indices for the hands: wrist, pinky, index and thumb knuckles.
HAND_POINTS = {"left": (15, 17, 19, 21), "right": (16, 18, 20, 22)}


def refine_mask(rgb: np.ndarray, soft_mask: np.ndarray) -> np.ndarray:
    """Edge-aware matte for captures: snaps the coarse segmentation to real edges (hair, sleeves). float32 0-1.

    A guided filter uses the photo itself as the guide, then the matte is tightened so the
    semi-transparent fringe where the room bleeds through (a grey halo) is dropped. Any smoothing
    here widens that fringe again, so renders use feathered_mask instead.
    """
    guide = rgb if rgb.dtype == np.uint8 else np.clip(rgb, 0, 255).astype(np.uint8)
    radius = max(2, int(max(rgb.shape[:2]) * 0.006))
    matte = cv2.ximgproc.guidedFilter(guide, soft_mask.astype(np.float32), radius, 1e-4)
    return np.clip((matte - 0.2) / 0.6, 0.0, 1.0).astype(np.float32)


def feathered_mask(soft_mask: np.ndarray) -> np.ndarray:
    """Matte for renders, which already sit on black: grown slightly so no clothing is ever cut,
    then feathered. No guided filter, so no blocky edges. float32 0-1."""
    size = max(soft_mask.shape[:2])
    grow = max(3, int(size * 0.006))
    grown = cv2.dilate(soft_mask.astype(np.float32), np.ones((grow, grow), np.uint8))
    return np.clip(cv2.GaussianBlur(grown, (0, 0), size * 0.003), 0.0, 1.0).astype(np.float32)


def hand_regions(analysis: FrameAnalysis, width: int, height: int) -> dict:
    """Per hand: a uint8 mask of the hand beyond the wrist, and its landmark points (normalized)."""
    regions = {}
    if analysis.landmarks is None:
        return regions
    lms = analysis.landmarks
    for side, (wrist_i, pinky_i, index_i, thumb_i) in HAND_POINTS.items():
        if min(lms[i][3] for i in (wrist_i, pinky_i, index_i)) < VISIBLE:
            continue
        pts = lms[[wrist_i, pinky_i, index_i, thumb_i], :2] * [width, height]
        wrist, pinky, index, thumb = pts
        knuckles = (pinky + index) / 2
        axis = knuckles - wrist
        size = float(np.linalg.norm(axis))
        if size < 4:
            continue
        # From just past the wrist (so a new sleeve cuff can change) out to the fingertips.
        polygon = np.array([wrist + axis * 0.35, pinky, knuckles + axis * 1.3, index, thumb], dtype=np.int32)
        mask = np.zeros((height, width), dtype=np.uint8)
        cv2.fillConvexPoly(mask, cv2.convexHull(polygon), 255)
        mask = cv2.dilate(mask, np.ones((max(3, int(size * 0.5)),) * 2, np.uint8))
        regions[side] = {"mask": mask, "points": lms[[wrist_i, index_i, pinky_i], :2].copy()}
    return regions
