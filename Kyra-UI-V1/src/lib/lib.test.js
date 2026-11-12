import assert from "node:assert/strict";
import { test } from "node:test";
import { ALL_SET_MS, FLASH_MS, captureStage } from "./captureSequence.js";
import { chromaOf, clarityOf, colourChips, paletteRoles } from "./colourRoles.js";
import { defaultGoal, fitNotes, GOALS, leversFor } from "./fitLevers.js";
import { COPY, guidanceView } from "./guidanceCopy.js";
import { createJpegSplitter } from "./mjpegStream.js";
import { DEFAULT_STYLE, intentQuery, visitIntent } from "./visitIntent.js";

test("onboarding choices become the backend's style and gender", () => {
  assert.deepEqual(visitIntent({}), { style: DEFAULT_STYLE, gender: null, piece: null });
  // Earlier screens pass "null" when they had no category.
  assert.deepEqual(visitIntent({ category: "null", q: "undefined" }), { style: DEFAULT_STYLE, gender: null, piece: null });
  assert.deepEqual(visitIntent({ category: "tops-male" }), { style: `${DEFAULT_STYLE}, built around a top`, gender: "male", piece: "a top" });
  assert.equal(visitIntent({ category: "footware-female" }).piece, "footwear", "the female screen's spelling");
  assert.equal(visitIntent({ category: "one-pieces-female" }).gender, "female");
  assert.deepEqual(visitIntent({ category: "somethingspecific", q: "  a beach   wedding " }), { style: "a beach wedding", gender: null, piece: null });
  assert.equal(visitIntent({ category: "bottoms-female", q: "office" }).style, "office, built around bottoms");
  const long = visitIntent({ q: "x".repeat(300) }).style;
  assert.equal(long.length, 120, "the backend takes at most 120 characters");
});

test("the intent travels between screens in the query string", () => {
  assert.equal(intentQuery({ category: "tops-male", q: "date night" }), "?category=tops-male&q=date+night");
  assert.equal(intentQuery({ category: "null", q: "" }), "");
});

test("camera guidance maps to the team's screen copy", () => {
  assert.equal(guidanceView({ perception: { state: "too_close" }, camera: "running" }).copy, COPY["too-close"]);
  assert.equal(guidanceView({ perception: { state: "no_person" }, camera: "running" }).copy, COPY["no-person"]);
  assert.deepEqual(guidanceView({ perception: { state: "ready" }, camera: "running", count: 2 }), { kind: "hold", count: 2 });
  assert.deepEqual(guidanceView({ perception: { state: "moving" }, camera: "running", count: 2 }), { kind: "hold", count: null });
  assert.equal(guidanceView({ perception: null, camera: "running" }).copy, COPY.loading);
  assert.equal(guidanceView({ perception: null, camera: "running" }).kind, "loading");
  assert.equal(guidanceView({ perception: { state: "ready" }, camera: "unavailable" }).copy, COPY["camera-unavailable"]);
  assert.deepEqual(guidanceView({ perception: { state: "new_state", message: "Do the new thing" }, camera: "running" }).copy, { title: "Do the new thing" });
});

test("the MJPEG reader finds whole JPEGs, however the bytes arrive", () => {
  const jpeg = (fill) => [0xff, 0xd8, fill, fill, 0xff, 0x00, fill, 0xff, 0xd9];
  const part = (bytes) => [...new TextEncoder().encode("--frame\r\nContent-Type: image/jpeg\r\n\r\n"), ...bytes, 0x0d, 0x0a];
  const stream = Uint8Array.from([...part(jpeg(1)), ...part(jpeg(2)), ...part(jpeg(3))]);
  for (const size of [1, 2, 7, stream.length]) {
    const split = createJpegSplitter();
    const frames = [];
    for (let i = 0; i < stream.length; i += size) frames.push(...split(stream.slice(i, i + size)));
    assert.deepEqual(frames.map((f) => Array.from(f)), [jpeg(1), jpeg(2), jpeg(3)], `chunks of ${size}`);
  }
});

test("after the photo: a flash, then All set, then the next screen", () => {
  assert.equal(captureStage(null, 5000), "live", "no photo yet");
  assert.equal(captureStage(1000, 1000), "flash");
  assert.equal(captureStage(1000, 1000 + FLASH_MS - 1), "flash");
  assert.equal(captureStage(1000, 1000 + FLASH_MS), "allset");
  assert.equal(captureStage(1000, 1000 + FLASH_MS + ALL_SET_MS - 1), "allset");
  assert.equal(captureStage(1000, 1000 + FLASH_MS + ALL_SET_MS), "done");
  assert.equal(captureStage(1000, 900), "flash", "a clock that steps back doesn't skip the flash");
});

// Two palettes from the backend (palette.js): warm medium (vivid) and neutral light (muted).
const WARM_MEDIUM = [["Terracotta", "#C8643B"], ["Olive", "#708238"], ["Mustard", "#D9A21B"], ["Rust", "#B7410E"], ["Teal", "#1F7A7A"], ["Camel", "#C19A6B"], ["Brown", "#6B4423"]].map(([name, hex]) => ({ name, hex }));
const NEUTRAL_LIGHT = [["Dusty rose", "#D4A5A5"], ["Soft teal", "#7FB3B0"], ["Taupe", "#A89A8C"], ["Jade", "#7EB89B"], ["Periwinkle", "#9AA6D6"]].map(([name, hex]) => ({ name, hex }));

test("skin tone card: five colours with roles, calm ones Core and the most vivid the Accent", () => {
  const roles = paletteRoles(WARM_MEDIUM);
  assert.deepEqual(roles.map((c) => c.role), ["Core", "Core", "Supporting", "Supporting", "Accent"]);
  assert.equal(roles.length, 5, "only the five best colours");
  assert.ok(!roles.some((c) => ["Camel", "Brown"].includes(c.name)), "taken from the top of the palette");
  const chroma = roles.map((c) => chromaOf(c.hex));
  assert.ok(chroma[4] >= Math.max(...chroma), "the accent is the most vivid");
  assert.ok(Math.max(chroma[0], chroma[1]) <= Math.min(chroma[2], chroma[3]), "core is calmer than supporting");
  assert.deepEqual(paletteRoles([]), []);
  assert.deepEqual(paletteRoles([{ name: "x", hex: "nope" }]), [], "bad colours are skipped");
});

test("skin tone card: clarity from the palette, chips only for what is known", () => {
  assert.equal(clarityOf(WARM_MEDIUM), "Clear");
  assert.equal(clarityOf(NEUTRAL_LIGHT), "Soft");
  assert.equal(clarityOf([]), null);
  const chips = colourChips({ undertone: "warm", olive: false, depth: "medium", skinHex: "#C08A6A", palette: WARM_MEDIUM });
  assert.deepEqual(chips.map((c) => c.label), ["Warm", "Medium", "Clear"]);
  assert.equal(chips[0].dot, "#C08A6A", "the undertone dot is the measured skin colour");
  assert.equal(colourChips({ undertone: "neutral", olive: true, palette: [] })[0].label, "Olive");
  assert.deepEqual(colourChips({ undertone: "cool", palette: [] }).map((c) => c.key), ["undertone"], "no depth, no clarity: no chips for them");
});

test("fit analysis: the first goal follows the profile; three levers per goal", () => {
  assert.equal(defaultGoal({ heightImpression: "petite", build: "broad" }), "longer");
  assert.equal(defaultGoal({ build: "broad" }), "balance");
  assert.equal(defaultGoal({ build: "slim" }), "add");
  assert.equal(defaultGoal(null), "longer");
  for (const goal of GOALS) {
    const levers = leversFor(goal.key);
    assert.equal(levers.length, 3, goal.key);
    levers.forEach((lever, i) => assert.ok(lever.ring === null || lever.ring === ["#dfa678", "#aaf867", "#ffffff"][i], `${goal.key} ${lever.label}`));
  }
  assert.deepEqual(leversFor("balance").map((l) => l.ring), [null, null, "#ffffff"], "the design's icons bring their own rings");
  assert.deepEqual(leversFor("longer").map((l) => l.label), ["Pointed-toe shoes", "Cropped hems", "Wide-leg trousers"], "the design's own example");
});

test("fit analysis: the outlines only explain what the camera measured", () => {
  const guidance = ["Petite: high-rise bottoms, cropped jackets.", "Broad build: V-necks and open collars."];
  const notes = fitNotes({ build: "broad", heightImpression: "petite", heightCm: 157.6 }, guidance);
  assert.match(notes.shoulders.text, /broad frame\. V-necks and open collars\.$/);
  assert.match(notes.height.text, /petite \(about 158 cm\)\. High-rise bottoms/);
  assert.deepEqual(fitNotes({ build: null, heightImpression: null }), { shoulders: null, height: null });
  assert.match(fitNotes({ build: "medium" }).shoulders.text, /balanced frame\.$/, "no guidance line: just the reading");
});
