import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSwipeDetector,
  pinchMeansBack,
  pinchStep,
  dragStep,
  dropTargetAt,
  dropZonesFor,
  holdStep,
  HOLD_MS,
  mainHand,
  palmPoint,
  steadyForPinch,
  SWIPE_COOLDOWN_MS,
} from "./handGestures.js";

// Landmark sequences shaped like MediaPipe's hand landmarker output: 21 points per hand, x and y from 0
// to 1 across the picture, at 30 frames a second. They are generated (seeded, so every run is the same),
// not captured from a camera: the kiosk's camera is off while this is built.
const FRAME_MS = 1000 / 30;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A hand whose palm centre (landmark 9) is at (x, y), palm length `size` (fraction of the height). */
function hand(x, y, size = 0.1) {
  const points = Array.from({ length: 21 }, (_, i) => ({ x: x + ((i % 5) - 2) * size * 0.15, y: y - (Math.floor(i / 5) - 1) * size * 0.3, z: 0 }));
  points[0] = { x, y: y + size, z: 0 }; // wrist, below the palm centre
  points[9] = { x, y, z: 0 };
  return points;
}

/** frames: [{ t, hands: [landmarks...] }] from a path function t -> { x, y } (or null: no hand). */
function record(ms, path, { size = 0.1, noise = 0.003, seed = 1 } = {}) {
  const random = rng(seed);
  const frames = [];
  for (let t = 0; t <= ms; t += FRAME_MS) {
    const p = path(t);
    const jitter = () => (random() * 2 - 1) * noise;
    frames.push({ t, hands: p ? [hand(p.x + jitter(), p.y + jitter(), size)] : [] });
  }
  return frames;
}

/** What the kiosk does each frame: pick the main hand, then feed its palm to the swipe detector. */
function swipes(frames, detector = createSwipeDetector()) {
  const fired = [];
  for (const { t, hands } of frames) {
    const main = mainHand(hands);
    const result = detector.feed(main ? { t, ...palmPoint(main) } : null);
    if (result) fired.push({ t: Math.round(t), result });
  }
  return fired;
}

const lerp = (a, b, f) => a + (b - a) * Math.min(1, Math.max(0, f));
const sweep = (x0, x1, start, ms) => (t) => ({ x: lerp(x0, x1, (t - start) / ms), y: 0.5 });

test("a fast sideways swipe fires once, in its direction", () => {
  assert.deepEqual(swipes(record(1000, sweep(0.3, 0.7, 200, 400))).map((s) => s.result), ["right"]);
  assert.deepEqual(swipes(record(1000, sweep(0.75, 0.4, 100, 450), { seed: 2 })).map((s) => s.result), ["left"]);
});

test("too short, too slow, or up and down: no swipe", () => {
  assert.deepEqual(swipes(record(1000, sweep(0.4, 0.6, 200, 300))), [], "only 20% of the picture");
  assert.deepEqual(swipes(record(2500, sweep(0.2, 0.8, 200, 2000))), [], "60% but over 2 s: a slow move");
  assert.deepEqual(swipes(record(1000, (t) => ({ x: 0.5, y: lerp(0.8, 0.3, (t - 200) / 300) }))), [], "raising the hand");
});

test("a slow wave doesn't swipe (the wave detector's job, on the start screens)", () => {
  // A friendly wave: 0.5 Hz, 20% of the picture from side to side, for 4 s.
  const wave = record(4000, (t) => ({ x: 0.5 + 0.1 * Math.sin((2 * Math.PI * t) / 2000), y: 0.5 }), { seed: 3 });
  assert.deepEqual(swipes(wave), []);
  // A big, slow arm sweep: 40% of the picture, one side to the other in 2 s.
  const sweepWave = record(6000, (t) => ({ x: 0.5 + 0.2 * Math.sin((2 * Math.PI * t) / 4000), y: 0.5 }), { seed: 4 });
  assert.deepEqual(swipes(sweepWave), []);
});

test("a jittery hand doesn't swipe: a tremor, or the landmarks jumping for a frame", () => {
  const tremor = record(10000, () => ({ x: 0.5, y: 0.5 }), { noise: 0.04, seed: 5 });
  assert.deepEqual(swipes(tremor), [], "±4% shaking for 10 s");
  const random = rng(6);
  const glitches = record(6000, (t) => {
    const frame = Math.round(t / FRAME_MS);
    return { x: frame % 15 === 7 ? 0.5 + (random() < 0.5 ? -0.3 : 0.3) : 0.5, y: 0.5 }; // one frame in 15 jumps 30%
  });
  assert.deepEqual(swipes(glitches), [], "single-frame jumps of 30%");
});

test("after a swipe, 1 s of nothing (no double swipes)", () => {
  const twice = record(2600, (t) => (t < 700 ? sweep(0.3, 0.7, 200, 400)(t) : sweep(0.7, 0.3, 800, 400)(t)));
  const fired = swipes(twice);
  assert.deepEqual(fired.map((s) => s.result), ["right"], "the swing back 0.5 s later is ignored");
  const later = record(3000, (t) => (t < 1500 ? sweep(0.3, 0.7, 200, 400)(t) : sweep(0.7, 0.3, 1800, 400)(t)));
  const both = swipes(later);
  assert.deepEqual(both.map((s) => s.result), ["right", "left"]);
  assert.ok(both[1].t - both[0].t >= SWIPE_COOLDOWN_MS);
});

test("only the main hand counts: the largest, big enough, not at the edge", () => {
  const near = hand(0.3, 0.5, 0.12);
  const behind = hand(0.7, 0.5, 0.07);
  assert.equal(mainHand([behind, near]), near, "the larger hand");
  assert.equal(mainHand([hand(0.5, 0.5, 0.03)]), null, "far back: too small");
  assert.equal(mainHand([hand(0.02, 0.5, 0.12)]), null, "half out of the picture");
  assert.equal(mainHand([hand(0.5, 0.985, 0.12)]), null, "at the bottom edge");
  // Someone far behind sweeps their hand across: nothing happens.
  const far = record(1000, sweep(0.2, 0.8, 200, 300), { size: 0.03 });
  assert.deepEqual(swipes(far), []);
  // The visitor holds still while someone behind swipes: still nothing.
  const random = rng(8);
  const crowd = [];
  for (let t = 0; t <= 1000; t += FRAME_MS) {
    const visitor = hand(0.5 + (random() - 0.5) * 0.006, 0.5, 0.12);
    const other = hand(lerp(0.2, 0.8, (t - 200) / 300), 0.4, 0.07);
    crowd.push({ t, hands: [other, visitor] });
  }
  assert.deepEqual(swipes(crowd), []);
});

test("a pinch only clicks when the hand is still, and not just after a swipe", () => {
  const still = [0, 50, 100, 150].map((t) => ({ t, x: 0.5, y: 0.5 }));
  assert.equal(steadyForPinch(still, 150), true);
  const sweeping = [0, 50, 100, 150].map((t) => ({ t, x: 0.3 + t * 0.002, y: 0.5 })); // 2 widths a second
  assert.equal(steadyForPinch(sweeping, 150), false);
  assert.equal(steadyForPinch(still, 150, { lastSwipeAt: -100 }), false, "250 ms after a swipe");
  assert.equal(steadyForPinch(still, 150, { lastSwipeAt: -500 }), true);
});

test("pinch and hold: fills over 1.5 s, cancelled by opening the pinch or moving off", () => {
  const started = { start: 1000 };
  assert.equal(holdStep(started, { pinching: true, inside: true, now: 1000 + HOLD_MS / 2 }).progress, 0.5);
  assert.deepEqual(holdStep(started, { pinching: false, inside: true, now: 1500 }), { state: null, progress: 0, done: false, cancelled: true });
  assert.equal(holdStep(started, { pinching: true, inside: false, now: 1500 }).cancelled, true, "moved off the bin");
  const done = holdStep(started, { pinching: true, inside: true, now: 1000 + HOLD_MS });
  assert.deepEqual([done.done, done.progress, done.state], [true, 1, null]);
  assert.equal(holdStep(null, { pinching: true, inside: true, now: 5000 }).done, false, "no hold running");
});

test("pick and drop: the bin and cart zones run down the sides, wide enough to reach sideways", () => {
  const frame = { left: 100, top: 0, right: 640, bottom: 1920 };
  const zones = dropZonesFor(["bin", "cart"], frame);
  assert.deepEqual(zones.map((z) => z.type), ["bin", "cart"]);
  assert.equal(dropTargetAt(150, 900, zones), "bin");
  assert.equal(dropTargetAt(600, 900, zones), "cart");
  assert.equal(dropTargetAt(370, 900, zones), null, "the middle: let go here to cancel");
  assert.equal(dropTargetAt(600, 1800, zones), null, "below the zones");
  assert.deepEqual(dropZonesFor(["cart"], frame).map((z) => z.type), ["cart"], "only the targets the screen has");
  const icons = [{ type: "cart", rect: { left: 560, top: 40, right: 620, bottom: 100 } }];
  assert.equal(dropTargetAt(590, 120, [], icons), "cart", "the header icon still works, with some slack");
  assert.equal(dropTargetAt(590, 200, [], icons), null);
});

test("pick and drop: letting go needs a few open frames; a hand out of view for a moment doesn't cancel", () => {
  const s = {};
  assert.equal(dragStep(s, { hand: true, pinching: true, now: 0 }), "continue");
  assert.equal(dragStep(s, { hand: true, pinching: false, now: 33 }), "continue", "one open frame: noise");
  assert.equal(dragStep(s, { hand: true, pinching: true, now: 66 }), "continue");
  assert.equal(dragStep(s, { hand: true, pinching: false, now: 99 }), "continue");
  assert.equal(dragStep(s, { hand: true, pinching: false, now: 132 }), "continue");
  assert.equal(dragStep(s, { hand: true, pinching: false, now: 165 }), "drop", "three open frames: let go");

  const t = {};
  assert.equal(dragStep(t, { hand: false, pinching: false, now: 1000 }), "continue");
  assert.equal(dragStep(t, { hand: false, pinching: false, now: 1400 }), "continue", "lost for 0.4 s");
  assert.equal(dragStep(t, { hand: true, pinching: true, now: 1430 }), "continue", "back: the drag goes on");
  assert.equal(dragStep(t, { hand: false, pinching: false, now: 2000 }), "continue");
  assert.equal(dragStep(t, { hand: false, pinching: false, now: 2600 }), "cancel", "gone over 0.5 s: cancelled");
});

test("a pinch needs the fingers closed 2 frames running; one noisy frame presses nothing", () => {
  let s = { pinching: false, closeFrames: 0 };
  s = pinchStep(s, 0.1);
  assert.equal(s.pinching, false, "one closed frame: not yet");
  s = pinchStep(s, 0.5);
  s = pinchStep(s, 0.1);
  assert.equal(s.pinching, false, "a gap resets the count");
  s = pinchStep(s, 0.12);
  assert.equal(s.pinching, true, "two running: a pinch");
  s = pinchStep(s, 0.3);
  assert.equal(s.pinching, true, "between the thresholds: still pinched (hysteresis)");
  s = pinchStep(s, 0.45);
  assert.equal(s.pinching, false, "opened past 0.4: released");
});

test("a pinch on empty screen only means back from a raised hand, not one resting low in the picture", () => {
  assert.equal(pinchMeansBack(0.4), true);
  assert.equal(pinchMeansBack(0.7), true);
  assert.equal(pinchMeansBack(0.85), false);
});
