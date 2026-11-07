"""Silhouette matching: make the render's body outline the visitor's own.

Image models redraw the body and drift towards a generic physique. After the render is aligned to the
capture, each row from the neck down is remapped horizontally so every body part (torso, each arm,
each leg) has the visitor's width and position at that height. Garments may stay up to LOOSE wider than
the body (coats, wide trousers), never narrower. Free and local: no extra image generation.

Webcam outlines are noisy (legs flicker between one and two parts, chairs touch the body), so the
outline is cleaned in 2D first, and the per-row corrections are blended down the body: stretches join
smoothly instead of each fading in and out, which left stair-steps. Render body left outside the
visitor's (cleaned) outline is cut against that 2D outline, not row by row.
"""

import cv2
import numpy as np

LOOSE = 0.12          # how much wider than the visitor a garment may stay
MIN_SEGMENT_PX = 4    # ignore slivers
MERGE_GAP_PX = 4      # join segments split by tiny gaps
MAX_SEGMENTS = 4      # torso + two arms (+ a gap between legs)
MIN_RUN_ROWS = 24     # a stretch of rows with the same body parts, long enough to correct smoothly
SMOOTH_ROWS = 15      # median window for edge positions, then a Gaussian of SMOOTH_SIGMA
SMOOTH_SIGMA = 5
VERTICAL_SIGMA = 0.008  # of image height: corrections are blended over rows so stretches join smoothly
CLEAN_PX = 0.012        # of image width: specks and notches smaller than this are removed from the outline
NOTCH_PX = 0.04         # of image width: the cut ignores outline notches up to this size (segmentation holes)
MAX_SHIFT = 0.5         # a row's correction never moves pixels by more than half the part's width


def _segments(row: np.ndarray) -> list[tuple[int, int]]:
    """[(start, end_inclusive)] of True runs, tiny gaps merged, slivers dropped."""
    padded = np.concatenate([[False], row, [False]])
    changes = np.flatnonzero(padded[1:] != padded[:-1])
    runs = [(int(changes[i]), int(changes[i + 1]) - 1) for i in range(0, len(changes), 2)]
    merged: list[list[int]] = []
    for start, end in runs:
        if merged and start - merged[-1][1] - 1 <= MERGE_GAP_PX:
            merged[-1][1] = end
        else:
            merged.append([start, end])
    return [(s, e) for s, e in merged if e - s + 1 >= MIN_SEGMENT_PX]


def _smooth(values: np.ndarray) -> np.ndarray:
    half = SMOOTH_ROWS // 2
    padded = np.pad(values, half, mode="edge")
    median = np.array([np.median(padded[i:i + SMOOTH_ROWS]) for i in range(len(values))])
    radius = 3 * SMOOTH_SIGMA
    kernel = np.exp(-0.5 * (np.arange(-radius, radius + 1) / SMOOTH_SIGMA) ** 2)
    return np.convolve(np.pad(median, radius, mode="edge"), kernel / kernel.sum(), mode="valid")


def _clean_outline(mask: np.ndarray, notch: float = CLEAN_PX) -> np.ndarray:
    """Binary outline with specks, notches up to `notch` (of width) and row-to-row jitter removed."""
    h, w = mask.shape
    ellipse = lambda size: cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (max(3, int(w * size) | 1),) * 2)
    binary = cv2.morphologyEx((mask > 0.5).astype(np.uint8), cv2.MORPH_OPEN, ellipse(CLEAN_PX))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, ellipse(notch))
    sigma_y = max(2.0, h * VERTICAL_SIGMA * 0.5)
    return cv2.GaussianBlur(binary.astype(np.float32), (0, 0), sigmaX=1.0, sigmaY=sigma_y) > 0.5


def _blend_rows(values: np.ndarray, weight: np.ndarray, sigma: float) -> tuple[np.ndarray, np.ndarray]:
    """Normalized vertical Gaussian: fills rows between stretches from their neighbours."""
    size = int(6 * sigma) | 1
    blur = lambda a: cv2.GaussianBlur(a.astype(np.float32), (1, size), sigmaX=0, sigmaY=sigma, borderType=cv2.BORDER_REPLICATE)
    total = blur(np.repeat(weight[:, None], values.shape[1], axis=1))
    blended = blur(values * weight[:, None]) / np.maximum(total, 1e-6)
    return blended, total[:, 0]


def match_silhouette(generated: np.ndarray, generated_mask: np.ndarray, original_mask: np.ndarray,
                     top: int, bottom: int) -> tuple[np.ndarray, dict]:
    """generated: HxWx3 render aligned to the capture; masks: HxW float 0-1; rows [top, bottom) are matched.

    Rows are grouped into stretches where the visitor and the render show the same number of body parts
    (e.g. arm | torso | arm). Each part keeps its identity within a stretch, so edges can be smoothed
    down the body, and the correction fades out at the stretch ends where parts join or split.
    """
    h, w = generated_mask.shape
    top, bottom = max(0, top), min(h, bottom)
    # Holes in the visitor's outline are segmentation errors, not body shape, so they are closed.
    gen_bin, org_bin = _clean_outline(generated_mask), _clean_outline(original_mask, NOTCH_PX)

    rows_segments = {}
    for y in range(top, bottom):
        org, gen = _segments(org_bin[y]), _segments(gen_bin[y])
        if org and len(org) == len(gen) <= MAX_SEGMENTS:
            rows_segments[y] = (org, gen)

    # Contiguous stretches of rows with the same number of parts.
    runs, current = [], []
    for y in range(top, bottom):
        entry = rows_segments.get(y)
        if entry and current and y == current[-1] + 1 and len(entry[0]) == len(rows_segments[current[-1]][0]):
            current.append(y)
        else:
            if len(current) >= MIN_RUN_ROWS:
                runs.append(current)
            current = [y] if entry else []
    if len(current) >= MIN_RUN_ROWS:
        runs.append(current)
    if not runs:
        return generated, {"applied": False, "matchedRows": 0}

    xs = np.arange(w, dtype=np.float32)
    shift = np.zeros((h, w), dtype=np.float32)
    inside = np.zeros((h, w), dtype=np.float32)  # where the visitor's (smoothed) outline is, per matched row
    weight = np.zeros(h, dtype=np.float32)
    width_error_before, width_error_after = [], []
    for run in runs:
        parts = len(rows_segments[run[0]][0])
        o = np.array([[seg for seg in rows_segments[y][0]] for y in run], dtype=np.float64)  # rows x parts x 2
        g = np.array([[seg for seg in rows_segments[y][1]] for y in run], dtype=np.float64)
        o = np.stack([np.stack([_smooth(o[:, i, j]) for j in range(2)], axis=1) for i in range(parts)], axis=1)
        g = np.stack([np.stack([_smooth(g[:, i, j]) for j in range(2)], axis=1) for i in range(parts)], axis=1)
        for k, y in enumerate(run):
            row_map = xs.copy()
            for i in range(parts):
                (oL, oR), (sL, sR) = o[k, i], g[k, i]
                wo, wg = oR - oL + 1, sR - sL + 1
                if wo <= 1 or wg <= 1:
                    continue
                wt = min(max(wg, wo), wo * (1 + LOOSE))
                center = (oL + oR) / 2
                t0, t1 = center - wt / 2, center + wt / 2
                sel = (xs >= t0) & (xs <= t1)
                mapped = sL + (xs[sel] - t0) * (sR - sL) / max(t1 - t0, 1.0)
                limit = MAX_SHIFT * max(wo, wg)
                row_map[sel] = xs[sel] + np.clip(mapped - xs[sel], -limit, limit)
                inside[y, sel] = 1.0
                width_error_before.append(abs(wg - wo) / wo)
                width_error_after.append(abs(wt - wo) / wo)
            shift[y] = row_map - xs
            weight[y] = 1.0

    # Blend corrections down the body; the strength fades only across long unmatched gaps.
    sigma = max(3.0, h * VERTICAL_SIGMA)
    blended, coverage = _blend_rows(shift, weight, sigma)
    strength = np.clip(coverage / 0.5, 0.0, 1.0)
    map_x = xs[None, :] + blended * strength[:, None]
    map_y = np.repeat(np.arange(h, dtype=np.float32)[:, None], w, axis=1)
    result = cv2.remap(generated, map_x.astype(np.float32), map_y, interpolation=cv2.INTER_LINEAR,
                       borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0))

    # Render body that ends up outside the visitor's outline (plus the LOOSE allowance) becomes background.
    warped_body = cv2.remap(gen_bin.astype(np.float32), map_x.astype(np.float32), map_y,
                            interpolation=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0) > 0.5
    # The allowed area is the same smoothed outline the warp used, blended down the body the same way,
    # so the cut edge and the warped edge agree in every row.
    allowed = _blend_rows(inside, weight, sigma)[0] > 0.5
    cut = warped_body & ~allowed & (strength[:, None] > 0.5)
    cut[:top], cut[bottom:] = False, False
    alpha = cv2.GaussianBlur(cut.astype(np.float32), (0, 0), 1.5)
    result = (result.astype(np.float32) * (1 - alpha[..., None])).astype(np.uint8)
    return result, {
        "applied": True,
        "matchedRows": int(sum(len(r) for r in runs)),
        "rowsInRange": int(bottom - top),
        "stretches": len(runs),
        "widthErrorBefore": round(float(np.mean(width_error_before)), 4),
        "widthErrorAfter": round(float(np.mean(width_error_after)), 4),
    }
