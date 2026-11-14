/**
 * Hand gestures on the kiosk, with thresholds chosen so they can't fire by accident. Pure: tested with
 * landmark sequences in handGestures.test.js. Coordinates are MediaPipe's: x and y from 0 to 1 across the
 * camera picture (x as shown on the mirror, so "right" is the visitor's right as they see it).
 *
 * Main hand: only the largest hand in view counts, if its palm (wrist to the middle finger's base) is at
 *   least MIN_HAND of the picture's height and its centre isn't within EDGE of the picture's border. A hand
 *   far back (someone behind the visitor) or half out of the picture is ignored.
 * Swipe (Suggestions only): a fast sideways move of at least SWIPE_TRAVEL of the picture's width within
 *   SWIPE_MS, mostly straight (not up or down, not back and forth), then SWIPE_COOLDOWN_MS of nothing.
 * Steady: a pinch only clicks when the hand is still (it isn't sweeping across the screen) and no swipe has
 *   just fired, so a swipe can't also press a button.
 * Hold: a pinch held on a hold target (the bin) for HOLD_MS fills a ring and then fires; opening the pinch
 *   or moving off the target cancels it.
 */
export const MIN_HAND = 0.06;
export const EDGE = 0.04;
export const SWIPE_TRAVEL = 0.25;
export const SWIPE_MS = 600;
export const SWIPE_COOLDOWN_MS = 1000;
export const STRAIGHTNESS = 0.8; // net sideways move / sideways path: back-and-forth jitter scores low
export const MIN_SWIPE_MS = 100; // a jump between two frames is a tracking glitch, not a swipe
export const STEADY_MS = 150;
export const STEADY_SPEED = 0.6; // picture widths per second: faster is a sweep, not a pinch
export const AFTER_SWIPE_MS = 400; // no pinch clicks this soon after a swipe
export const HOLD_MS = 1500;

/** Palm length as a fraction of the picture's height. */
export function handSize(landmarks, { vw = 1, vh = 1 } = {}) {
  const wrist = landmarks[0];
  const middle = landmarks[9];
  return Math.hypot((wrist.x - middle.x) * vw, (wrist.y - middle.y) * vh) / vh;
}

/** The hand that counts, or null: the largest that is big enough and not at the edge. */
export function mainHand(hands = [], { vw = 1, vh = 1, minSize = MIN_HAND, edge = EDGE } = {}) {
  let best = null;
  let bestSize = 0;
  for (const landmarks of hands) {
    if (!landmarks?.[9]) continue;
    const size = handSize(landmarks, { vw, vh });
    const { x, y } = landmarks[9];
    const inside = x >= edge && x <= 1 - edge && y >= edge && y <= 1 - edge;
    if (size >= minSize && inside && size > bestSize) {
      best = landmarks;
      bestSize = size;
    }
  }
  return best;
}

/** Where the hand is, for swipes: the palm's centre (the middle finger's base), as shown on the mirror. */
export function palmPoint(landmarks, { mirror = false } = {}) {
  const { x, y } = landmarks[9];
  return { x: mirror ? 1 - x : x, y };
}

/**
 * feed({ t, x, y }) once per camera frame (t in ms; x, y from palmPoint), or feed(null) when no hand.
 * Returns "left" or "right" when a swipe completes, else null.
 */
export function createSwipeDetector({ travel = SWIPE_TRAVEL, windowMs = SWIPE_MS, cooldownMs = SWIPE_COOLDOWN_MS, straightness = STRAIGHTNESS, minMs = MIN_SWIPE_MS } = {}) {
  let raw = [];
  let samples = [];
  let quietUntil = -Infinity;
  const median = (a, b, c) => Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
  return {
    feed(sample) {
      if (!sample) {
        raw = [];
        samples = [];
        return null;
      }
      const { t } = sample;
      // A 3-frame median: one frame where the landmarks jump (a glitch) doesn't move the hand.
      raw = [...raw.slice(-2), sample];
      const point =
        raw.length < 3
          ? sample
          : { t, x: median(raw[0].x, raw[1].x, raw[2].x), y: median(raw[0].y, raw[1].y, raw[2].y) };
      if (t < quietUntil) {
        samples = [point];
        return null;
      }
      samples.push(point);
      samples = samples.filter((s) => t - s.t <= windowMs);
      // The longest sideways move ending now, within the window.
      for (let i = 0; i < samples.length - 2; i += 1) {
        const from = samples[i];
        const dx = point.x - from.x;
        const dy = point.y - from.y;
        if (t - from.t < minMs || Math.abs(dx) < travel || Math.abs(dy) > 0.5 * Math.abs(dx)) continue;
        let path = 0;
        for (let j = i + 1; j < samples.length; j += 1) path += Math.abs(samples[j].x - samples[j - 1].x);
        if (Math.abs(dx) / path < straightness) continue;
        samples = [];
        raw = [];
        quietUntil = t + cooldownMs;
        return dx > 0 ? "right" : "left";
      }
      return null;
    },
    /** When the last swipe fired its cooldown ends at this time. */
    get quietUntil() {
      return quietUntil;
    },
  };
}

/**
 * Is the hand still enough for a pinch to click? history: recent { t, x, y } (picture fractions).
 * lastSwipeAt: when a swipe last fired.
 */
export function steadyForPinch(history, now, { lastSwipeAt = -Infinity, windowMs = STEADY_MS, maxSpeed = STEADY_SPEED, afterSwipeMs = AFTER_SWIPE_MS } = {}) {
  if (now - lastSwipeAt < afterSwipeMs) return false;
  const recent = history.filter((s) => now - s.t <= windowMs);
  if (recent.length < 2) return true;
  const first = recent[0];
  const last = recent[recent.length - 1];
  const seconds = Math.max(0.001, (last.t - first.t) / 1000);
  return Math.hypot(last.x - first.x, last.y - first.y) / seconds <= maxSpeed;
}

/**
 * One frame of a pinch-and-hold. state: { start } (or null when no hold is running).
 * -> { state, progress (0 to 1), done, cancelled }
 */
export function holdStep(state, { pinching, inside, now, holdMs = HOLD_MS }) {
  if (!state) return { state: null, progress: 0, done: false, cancelled: false };
  if (!pinching || !inside) return { state: null, progress: 0, done: false, cancelled: true };
  const progress = Math.min(1, (now - state.start) / holdMs);
  if (progress >= 1) return { state: null, progress: 1, done: true, cancelled: false };
  return { state, progress, done: false, cancelled: false };
}

// ---- Pick and drop (pinch, drag, let go on the cart or the bin) ----

export const RELEASE_FRAMES = 3; // the pinch must look open this many frames running to count as letting go
export const LOST_GRACE_MS = 500; // the hand may drop out of the camera's view this long without cancelling

/**
 * The big drop zones shown while something is being dragged, inside the screen's rect (screen pixels):
 * the bin down the left side, the cart down the right, where the header shows them, but tall and wide enough
 * to reach with a sideways move (the header icons sit at the camera picture's top edge, where hands are lost).
 * types: the drop targets the screen has ("bin", "cart"). -> [{ type, rect: { left, top, right, bottom } }]
 */
export function dropZonesFor(types, frame, { widthShare = 0.32, top = 0.13, bottom = 0.75 } = {}) {
  const w = frame.right - frame.left;
  const h = frame.bottom - frame.top;
  const band = { top: frame.top + h * top, bottom: frame.top + h * bottom };
  const zones = [];
  if (types.includes("bin")) zones.push({ type: "bin", rect: { left: frame.left, right: frame.left + w * widthShare, ...band } });
  if (types.includes("cart")) zones.push({ type: "cart", rect: { left: frame.right - w * widthShare, right: frame.right, ...band } });
  return zones;
}

/** Which drop target (x, y) is over: inside a zone, or within tolerance of a header icon. -> type or null */
export function dropTargetAt(x, y, zones = [], icons = [], tolerance = 40) {
  for (const { type, rect } of zones) {
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return type;
  }
  let best = null;
  let bestDist = Infinity;
  for (const { type, rect } of icons) {
    const d = Math.hypot(Math.max(rect.left - x, 0, x - rect.right), Math.max(rect.top - y, 0, y - rect.bottom));
    if (d <= tolerance && d < bestDist) {
      best = type;
      bestDist = d;
    }
  }
  return best;
}

/**
 * One camera frame of a drag. state: { openFrames, lostAt }; hand: is a hand in view; pinching: is it pinched.
 * -> "continue" | "drop" (let go: drop on what it was over while still pinched) | "cancel" (the hand left).
 * Mutates state (the frame counters).
 */
export function dragStep(state, { hand, pinching, now, releaseFrames = RELEASE_FRAMES, lostGraceMs = LOST_GRACE_MS }) {
  if (!hand) {
    state.lostAt ??= now;
    return now - state.lostAt > lostGraceMs ? "cancel" : "continue";
  }
  state.lostAt = null;
  if (pinching) {
    state.openFrames = 0;
    return "continue";
  }
  state.openFrames = (state.openFrames || 0) + 1;
  return state.openFrames >= releaseFrames ? "drop" : "continue";
}

// ---- Fewer accidental pinches ----

export const PINCH_FRAMES = 2; // the fingers must look closed this many camera frames running to start a pinch
export const BACK_MAX_Y = 0.7; // a pinch on empty screen only means "back" from a hand above this (picture height)

/**
 * One camera frame of pinch detection, with hysteresis: closing past `on` for `frames` frames running starts
 * a pinch (one noisy frame can't press anything); opening past `off` ends it.
 * state: { pinching, closeFrames }; ratio: thumb-index gap / hand size. -> the next state.
 */
export function pinchStep(state, ratio, { on = 0.25, off = 0.4, frames = PINCH_FRAMES } = {}) {
  const closeFrames = ratio < on ? state.closeFrames + 1 : 0;
  if (!state.pinching && closeFrames >= frames) return { pinching: true, closeFrames };
  if (state.pinching && ratio > off) return { pinching: false, closeFrames };
  return { pinching: state.pinching, closeFrames };
}

/** Does a pinch on empty screen count as "back"? Not from a hand low in the picture (resting on a desk). */
export const pinchMeansBack = (py, maxY = BACK_MAX_Y) => py <= maxY;
