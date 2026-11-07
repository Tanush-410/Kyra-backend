"""Finishing a render: paste the visitor's real head and hands back where the render stayed aligned,
black out the background with an edge-aware matte, and check identity. One call, all local."""

import cv2
import numpy as np

from .color import skin_pixel_mask
from .perception import CHIN, LEFT_ANKLE, LEFT_SHOULDER, RIGHT_ANKLE, RIGHT_SHOULDER, Perception, feathered_mask, hand_regions, refine_mask
from .silhouette import match_silhouette

# Landmarks used to line the render up with the capture: nose, shoulders, hips, wrists, ankles.
ALIGN_POINTS = [0, 11, 12, 23, 24, 15, 16, 27, 28]
MAX_WARP_SCALE_CHANGE = 0.15
MAX_FACE_SHIFT = 0.03
FACE_SCALE_RANGE = (0.9, 1.1)
MAX_HAND_SHIFT = 0.025
SIMILARITY_THRESHOLD = 0.363  # SFace cosine threshold recommended by OpenCV
# A captured face enlarged this much (or this small) looks soft pasted next to a sharp render.
MAX_FACE_UPSCALE = 1.4
MIN_FACE_SOURCE_PX = 60


def _face_alignment(reference: dict | None, candidate: dict | None) -> dict:
    if reference is None or candidate is None:
        return {"faceFound": False}
    rb, cb = reference["box"], candidate["box"]
    shift = float(np.hypot((rb["x"] + rb["width"] / 2) - (cb["x"] + cb["width"] / 2),
                           (rb["y"] + rb["height"] / 2) - (cb["y"] + cb["height"] / 2)))
    scale = cb["height"] / max(rb["height"], 1e-6)
    return {
        "faceFound": True,
        "shift": round(shift, 4),
        "scaleRatio": round(scale, 4),
        "aligned": shift <= MAX_FACE_SHIFT and FACE_SCALE_RANGE[0] <= scale <= FACE_SCALE_RANGE[1],
        "similarity": round(float(reference["embedding"] @ candidate["embedding"]), 4),
    }


def align_to_original(original_analysis, generated: np.ndarray, generated_analysis) -> tuple[np.ndarray, dict | None]:
    """Warps the render onto the capture's body landmarks (scale, rotation, shift only).

    Image models often redraw the person a few percent larger or offset; undoing that lets the real
    head and hands be pasted back far more often.
    """
    if original_analysis.landmarks is None or generated_analysis.landmarks is None:
        return generated, None
    h, w = generated.shape[:2]
    a, b = original_analysis.landmarks, generated_analysis.landmarks
    visible = [i for i in ALIGN_POINTS if a[i][3] >= 0.5 and b[i][3] >= 0.5]
    if len(visible) < 5:
        return generated, None
    src = (b[visible, :2] * [w, h]).astype(np.float32)
    dst = (a[visible, :2] * [w, h]).astype(np.float32)
    matrix, inliers = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=w * 0.02)
    if matrix is None or inliers is None or int(inliers.sum()) < 5:
        return generated, None
    scale = float(np.hypot(matrix[0, 0], matrix[1, 0]))
    if abs(scale - 1) > MAX_WARP_SCALE_CHANGE:
        return generated, None
    warped = cv2.warpAffine(generated, matrix, (w, h), flags=cv2.INTER_CUBIC, borderValue=(0, 0, 0))
    return warped, {"scale": round(scale, 4), "dx": round(float(matrix[0, 2]) / w, 4), "dy": round(float(matrix[1, 2]) / h, 4)}


def finish_render(perception: Perception, original: np.ndarray, generated: np.ndarray, keep_mask: np.ndarray,
                  reference_face: np.ndarray | None = None, face_source_px: float | None = None,
                  upscale: float | None = None) -> dict:
    """original/generated: RGB uint8 at the same size; keep_mask: uint8 soft face-and-hair mask for the original.

    reference_face: a sharp close-up of the visitor, used as the identity reference when given.
    face_source_px / upscale: how wide the face was in the camera frame and how much the crop was
    enlarged. A face enlarged by MAX_FACE_UPSCALE or more (or tiny) is too soft to paste over a sharp
    render, so the render's face is kept if it is still them.
    """
    h, w = original.shape[:2]
    if generated.shape[:2] != (h, w):
        generated = cv2.resize(generated, (w, h), interpolation=cv2.INTER_CUBIC)

    original_analysis = perception.analyze(original)
    generated, warp = align_to_original(original_analysis, generated, perception.analyze(generated))
    generated_analysis = perception.analyze(generated)
    original_matte = (refine_mask(original, original_analysis.person_mask)
                      if original_analysis.person_mask is not None else None)

    # The visitor's body outline, from the neck down to the feet.
    silhouette = {"applied": False}
    if original_matte is not None and generated_analysis.person_mask is not None and original_analysis.landmarks is not None:
        lms = original_analysis.landmarks
        if original_analysis.face_landmarks is not None:
            top = int(original_analysis.face_landmarks[CHIN, 1] * h + h * 0.01)
        else:
            top = int(min(lms[LEFT_SHOULDER][1], lms[RIGHT_SHOULDER][1]) * h - h * 0.03)
        # Stop at the ankles: shoes and the floor contact are left as rendered.
        bottom = int(min(h, max(lms[LEFT_ANKLE][1], lms[RIGHT_ANKLE][1]) * h))
        generated, silhouette = match_silhouette(generated, generated_analysis.person_mask, original_matte, top, bottom)
        if silhouette.get("applied"):
            generated_analysis = perception.analyze(generated)

    positional = perception.face_identity(original)
    reference = perception.face_identity(reference_face) if reference_face is not None else None
    reference = reference or positional
    generated_face = perception.face_identity(generated)
    alignment = _face_alignment(positional, generated_face)
    render_face_similarity = (round(float(reference["embedding"] @ generated_face["embedding"]), 4)
                              if reference and generated_face else None)

    low_res = (upscale is not None and upscale >= MAX_FACE_UPSCALE) or (face_source_px is not None and face_source_px < MIN_FACE_SOURCE_PX)
    render_face_ok = render_face_similarity is not None and render_face_similarity >= SIMILARITY_THRESHOLD
    keep = np.zeros((h, w), dtype=np.float32)
    if alignment.get("aligned") and (not low_res or not render_face_ok):
        keep = np.maximum(keep, keep_mask.astype(np.float32) / 255.0)
        head = "pasted" if not low_res else "pasted (render face failed the identity check)"
    elif low_res and render_face_ok:
        head = f"kept render face (camera face {face_source_px or 0:.0f} px wide, enlarged x{upscale or 1:.1f})"
    else:
        head = "not aligned; kept render face"

    # Hands: paste each one only if it is in the same place in the render.
    hands_pasted = []
    original_hands = hand_regions(original_analysis, w, h)
    generated_hands = hand_regions(generated_analysis, w, h)
    # Only skin is pasted, so old sleeves or trousers next to the hand never come back.
    skin = cv2.morphologyEx(skin_pixel_mask(original).astype(np.uint8) * 255, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    for side, hand in original_hands.items():
        other = generated_hands.get(side)
        if other is None or original_matte is None:
            continue
        if float(np.linalg.norm(hand["points"] - other["points"], axis=1).max()) > MAX_HAND_SHIFT:
            continue
        soft = cv2.GaussianBlur(cv2.bitwise_and(hand["mask"], skin), (0, 0), w * 0.002).astype(np.float32) / 255.0
        keep = np.maximum(keep, soft * original_matte)
        hands_pasted.append(side)

    composed = (generated.astype(np.float32) * (1 - keep[..., None]) + original.astype(np.float32) * keep[..., None])
    composed = np.clip(composed, 0, 255).astype(np.uint8)

    # Black background from a fresh matte of the composed image (the new clothes change the silhouette).
    final_analysis = perception.analyze(composed)
    if final_analysis.person_mask is not None:
        matte = feathered_mask(cv2.resize(final_analysis.person_mask, (w, h)))
        composed = (composed.astype(np.float32) * matte[..., None]).astype(np.uint8)

    final_face = perception.face_identity(composed)
    similarity = round(float(reference["embedding"] @ final_face["embedding"]), 4) if reference and final_face else None
    return {
        "image": composed,
        "headPasted": bool(keep_mask is not None and head.startswith("pasted")),
        "headDecision": head,
        "warp": warp,
        "silhouette": silhouette,
        "handsPasted": hands_pasted,
        "alignment": alignment,
        "renderFaceSimilarity": render_face_similarity,
        "similarity": similarity,
        "samePerson": similarity is not None and similarity >= SIMILARITY_THRESHOLD,
        "threshold": SIMILARITY_THRESHOLD,
        "identityReference": "close-up" if reference_face is not None and reference is not positional else "capture",
    }
