import assert from "node:assert/strict";
import { test } from "node:test";
import { ALL_SET_MS, FLASH_MS, captureStage } from "./captureSequence.js";
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
