import assert from "node:assert/strict";
import { test } from "node:test";
import { ALL_SET_MS, FLASH_MS, captureStage } from "./captureSequence.js";
import { chromaOf, clarityOf, colourChips, paletteRoles } from "./colourRoles.js";
import { defaultGoal, fitNotes, GOALS, leversFor } from "./fitLevers.js";
import { nextOptionOf, tryOnState } from "./tryOnView.js";
import { editFeedback, editPieces, INTENTS, MAX_FEEDBACK, moreLikeFeedback } from "./editFeedback.js";
import { allOutfits, outfitCount, setStart } from "./outfits.js";
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
  assert.equal(intentQuery({ category: "tops-male", q: "date night" }), "?category=tops-male", "spoken words never go in the address");
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
  for (const goal of GOALS) assert.equal(leversFor(goal.key).length, 3, goal.key);
  assert.deepEqual(leversFor("longer").map((l) => l.label), ["Pointed-toe shoes", "Cropped tops", "Wide-leg trousers"]);
  assert.deepEqual(leversFor("balance").map((l) => l.label), ["V-necklines", "Wide-leg or A-line bottoms", "Darker tops with lighter bottoms"]);
  assert.ok(leversFor("reduce").some((l) => l.label === "Defined waist"));
});

test("fit analysis: the design's icons for female visitors, neutral ones for everyone else", () => {
  const icons = (options) => GOALS.flatMap((g) => leversFor(g.key, options).map((l) => l.icon));
  for (const icon of icons({})) assert.ok(["shoes.png", "tops.png", "bottoms.png"].includes(icon), icon);
  assert.ok(!icons({ female: true }).some((icon) => /dress|bag/.test(icon)));
  assert.deepEqual(leversFor("longer", { female: true }).map((l) => [l.icon, l.ring]), [["lever-heels.png", null], ["lever-tee.png", null], ["lever-trousers.png", null]], "the design's example, rings included");
  assert.deepEqual(leversFor("longer").map((l) => l.ring), ["#dfa678", "#aaf867", "#ffffff"], "the same ring colours, drawn");
});

test("fit analysis: the outlines only explain what the camera measured", () => {
  const guidance = ["Petite: high-rise bottoms, cropped jackets.", "Broad build: V-necks and open collars."];
  const notes = fitNotes({ build: "broad", heightImpression: "petite", heightCm: 157.6 }, guidance);
  assert.match(notes.shoulders.text, /broad frame\. V-necks and open collars\.$/);
  assert.match(notes.height.text, /petite \(about 158 cm\)\. High-rise bottoms/);
  assert.deepEqual(fitNotes({ build: null, heightImpression: null }), { shoulders: null, height: null });
  assert.match(fitNotes({ build: "medium" }).shoulders.text, /balanced frame\.$/, "no guidance line: just the reading");
});

const looks = (renders = {}, extra = {}) => ({
  rounds: { 1: [{ option: 1, title: "A", items: [] }, { option: 2, title: "B", items: [] }, { option: 3, title: "C", items: [] }] },
  currentRound: 1,
  active: { round: 1, option: 1 },
  renders,
  degraded: null,
  ...extra,
});

test("try-on: the picture, the star while waiting, cards when it failed or pictures are off", () => {
  assert.equal(tryOnState({ rounds: {}, currentRound: 0, renders: {} }).kind, "loading", "no outfits yet");
  assert.equal(tryOnState(looks({ "1.1": { status: "queued" } })).caption, "Your look is next in line…");
  assert.equal(tryOnState(looks({ "1.1": { status: "rendering" } })).caption, "Creating your look…");
  assert.equal(tryOnState(looks({ "1.1": { status: "done", imageDataUrl: null } })).kind, "loading", "done but the picture not here yet");
  assert.equal(tryOnState(looks({ "1.1": { status: "done", imageDataUrl: "data:x" } })).kind, "ready");
  const failed = tryOnState(looks({ "1.1": { status: "failed", error: "The picture service is busy." } }));
  assert.deepEqual([failed.kind, failed.message], ["failed", "The picture service is busy."]);
  const text = tryOnState(looks({}, { degraded: { message: "Pictures are paused." } }));
  assert.deepEqual([text.kind, text.message, text.option.title], ["text", "Pictures are paused.", "A"]);
  assert.equal(tryOnState(looks({ "1.1": { status: "done", imageDataUrl: "data:x" } }, { degraded: { message: "" } })).kind, "ready", "a picture made before still shows");
});

test("try-on: another look is the round's next outfit, wrapping; none when there is only one", () => {
  assert.deepEqual(nextOptionOf(looks()), { round: 1, option: 2 });
  assert.deepEqual(nextOptionOf(looks({}, { active: { round: 1, option: 3 } })), { round: 1, option: 1 });
  assert.equal(nextOptionOf({ rounds: { 1: [{ option: 1, items: [] }] }, currentRound: 1, active: { round: 1, option: 1 } }), null);
});

const OLIVE = {
  title: "Olive weekend",
  items: [
    { category: "top", name: "Crew tee" },
    { category: "bottom", name: "Wide-leg trousers" },
    { category: "shoes", name: "Loafers" },
  ],
};

// The backend's promptText keeps only these; anything else would turn into a space there.
const PROMPT_SAFE = /^[\p{L}\p{M}\p{N} .,'&()/%+-]*$/u;

test("an edit says what to keep (the rest, by name) and what to change", () => {
  assert.equal(
    editFeedback({ option: OLIVE, piece: "top", intent: "different" }),
    "Keep the rest of the outfit 'Olive weekend' (Wide-leg trousers, Loafers). Change the top (something different)."
  );
  assert.equal(
    editFeedback({ option: OLIVE, piece: "bottom", intent: "know", words: "  black   jeans! " }),
    "Keep the rest of the outfit 'Olive weekend' (Crew tee, Loafers). Change the bottoms (black jeans)."
  );
  assert.match(editFeedback({ option: OLIVE, piece: "top", intent: "similar" }), /Change the top \(something similar\)\.$/);
  assert.match(editFeedback({ option: OLIVE, piece: "accessory", intent: "suggest", words: "a gold watch" }), /\(Crew tee, Wide-leg trousers, Loafers\)\. Add the accessories \(a gold watch\)\.$/, "nothing to change: add");
  assert.match(editFeedback({ option: OLIVE, piece: "top", intent: "suggest", words: "" }), /\(something different\)\.$/, "no words heard: something different");
});

test("edits and More like this survive the backend's prompt cleaner and its 200 characters", () => {
  const long = { title: "A very long outfit title that goes on and on and on", items: Array.from({ length: 6 }, (_, i) => ({ category: i ? "accessory" : "top", name: `A long piece name number ${i}` })) };
  const text = editFeedback({ option: long, piece: "top", intent: "know", words: "something in deep green: relaxed fit" });
  assert.ok(text.length <= MAX_FEEDBACK, text.length);
  assert.match(text, /Change the top \(something in deep green relaxed fit\)\.$/);
  assert.match(text, /, \.\.\.\)/, "some kept pieces left out, and it says so");
  const rambling = editFeedback({ option: OLIVE, piece: "top", intent: "know", words: "word ".repeat(80) });
  assert.ok(rambling.length <= MAX_FEEDBACK, rambling.length);
  const more = moreLikeFeedback({ title: "Olive weekend", summary: "Olive tee with cream: easy basics" });
  assert.equal(more, "More like the outfit 'Olive weekend' (Olive tee with cream easy basics). Keep its style and colours, with different pieces.");
  assert.ok(moreLikeFeedback({ title: "x", summary: "y ".repeat(150) }).length <= MAX_FEEDBACK);
  for (const t of [text, rambling, more, editFeedback({ option: { title: "Smart \u201Cdate\u201D night; v2", items: OLIVE.items }, piece: "top", intent: "similar" })]) {
    assert.match(t, PROMPT_SAFE, t);
  }
});

test("edit choices: the design's categories for women, neutral ones otherwise", () => {
  assert.deepEqual(editPieces("female").map((p) => p.key), ["top", "bottom", "shoes", "accessory", "onepiece"]);
  for (const gender of ["male", null]) {
    assert.ok(!editPieces(gender).some((p) => /women|dress|bag/.test(p.icon)), String(gender));
  }
  assert.deepEqual(INTENTS.map((i) => i.label), ["Something similar", "Something different", "Suggest changes", "I know what I want"]);
});

test("suggestions keep every set: oldest first, the newest set's start, and where you are", () => {
  const session = { rounds: { 2: [{ option: 1, title: "D" }, { option: 2, title: "E" }, { option: 3, title: "F" }], 1: [{ option: 1, title: "A" }, { option: 2, title: "B" }, { option: 3, title: "C" }] } };
  const outfits = allOutfits(session);
  assert.deepEqual(outfits.map((o) => `${o.round}.${o.option}`), ["1.1", "1.2", "1.3", "2.1", "2.2", "2.3"]);
  assert.equal(setStart(outfits, 2), 3);
  assert.equal(setStart(outfits, 9), 0);
  assert.equal(outfitCount(outfits, 4), "Set 2 of 2 · 2 of 3");
  assert.equal(outfitCount(allOutfits({ rounds: { 1: session.rounds[1] } }), 1), "2 of 3", "one set: just the position");
  assert.deepEqual(allOutfits({ rounds: { 1: [] } }), []);
});
