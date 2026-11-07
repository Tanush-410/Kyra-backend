"""Placing the visit's clearest face onto a render: lining up, safety checks, and choosing the best view."""

import cv2
import numpy as np

from kyra_sidecar.facetransfer import BROWS, JAW, crop_face, eye_openness, face_quality, head_pose, transfer_face


def mesh(cx: float, cy: float, s: float, yaw: float = 0.0, eyes_open: bool = True) -> np.ndarray:
    """A 478-point face mesh in pixels with the points the transfer uses placed like a real face.
    s is half the distance between the eye centres; yaw moves the nose sideways (a turned head)."""
    p = np.tile([cx, cy + 0.5 * s], (478, 1)).astype(np.float64)
    lid = 0.12 * s if eyes_open else 0.02 * s
    p[33], p[133], p[159], p[145] = [cx - 1.5 * s, cy], [cx - 0.5 * s, cy], [cx - s, cy - lid], [cx - s, cy + lid]
    p[362], p[263], p[386], p[374] = [cx + 0.5 * s, cy], [cx + 1.5 * s, cy], [cx + s, cy - lid], [cx + s, cy + lid]
    for i, k in zip((168, 6, 197, 4, 1), (0.1, 0.3, 0.5, 0.75, 0.9)):
        p[i] = [cx + yaw * 2 * s * k, cy + k * s]
    p[61], p[291], p[199], p[152] = [cx - 0.7 * s, cy + 1.5 * s], [cx + 0.7 * s, cy + 1.5 * s], [cx, cy + 1.9 * s], [cx, cy + 2.3 * s]
    for j, i in enumerate(BROWS):
        p[i] = [cx - 1.6 * s + j * (3.2 * s / (len(BROWS) - 1)), cy - 0.5 * s]
    angles = np.linspace(np.pi, 0, len(JAW))
    for i, a in zip(JAW, angles):
        p[i] = [cx + 1.9 * s * np.cos(a), cy + 0.2 * s + 2.1 * s * np.sin(a)]
    return p


def textured(size: int, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    noise = cv2.resize(rng.integers(60, 200, (size // 8, size // 8, 3)).astype(np.uint8), (size, size), interpolation=cv2.INTER_NEAREST)
    return noise


def test_head_pose_and_eyes_are_read_from_the_mesh():
    assert abs(head_pose(mesh(200, 200, 40))["yaw"]) < 0.01
    assert head_pose(mesh(200, 200, 40, yaw=0.3))["yaw"] > 0.2
    assert eye_openness(mesh(200, 200, 40)) > 0.2 > eye_openness(mesh(200, 200, 40, eyes_open=False))


def test_the_clear_face_is_lined_up_and_blended_inside_the_face_only():
    target = np.full((400, 400, 3), 120, np.uint8)
    target_points = mesh(200, 180, 25)
    source = textured(512, 1)
    source_points = mesh(256, 220, 60)
    placed, report = transfer_face(target, target_points, source, source_points)
    assert placed is not None, report
    assert report["fitError"] < 0.02 and abs(report["scale"] - 25 / 60) < 0.02
    inside = (slice(165, 215), slice(180, 220))     # between the eyes and the mouth
    outside = (slice(0, 60), slice(0, 60))          # far from the face
    assert placed[inside].std() > 5, "the close-up's detail is now in the face"
    assert np.array_equal(placed[outside], target[outside]), "nothing outside the face changes"
    assert abs(float(placed[inside].mean()) - 120) < 12, "colour is matched to the render's light"


def test_faces_looking_different_ways_or_closed_eyes_are_not_transferred():
    target = np.full((400, 400, 3), 120, np.uint8)
    turned, report = transfer_face(target, mesh(200, 180, 25), textured(512, 2), mesh(256, 220, 60, yaw=0.45))
    assert turned is None and "turned too far" in report["reason"]
    opposite, report = transfer_face(target, mesh(200, 180, 25, yaw=-0.17), textured(512, 2), mesh(256, 220, 60, yaw=0.17))
    assert opposite is None and "different directions" in report["reason"]
    blinking, report = transfer_face(target, mesh(200, 180, 25), textured(512, 3), mesh(256, 220, 60, eyes_open=False))
    assert blinking is None and "eyes closed" in report["reason"]


def test_the_clearest_view_scores_highest():
    sharp = textured(800, 4)
    blurry = cv2.GaussianBlur(sharp, (0, 0), 6)
    close, far = mesh(400, 350, 60), mesh(400, 350, 20)
    assert face_quality(sharp, close, 240)["score"] > face_quality(sharp, far, 80)["score"], "bigger is better"
    assert face_quality(sharp, close, 240)["score"] > face_quality(blurry, close, 240)["score"], "sharper is better"
    assert face_quality(sharp, close, 240)["score"] > face_quality(sharp, mesh(400, 350, 60, yaw=0.25), 240)["score"], "facing is better"
    assert face_quality(sharp, close, 240)["score"] > face_quality(sharp, mesh(400, 350, 60, eyes_open=False), 240)["score"]
    assert crop_face(sharp, close).shape == (512, 512, 3)
