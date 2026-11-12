import assert from "node:assert/strict";
import { test } from "node:test";
import { activeOption, activeRender, countdown, initialState, phaseOf, sessionReducer, undertoneView } from "./sessionReducer.js";

const ID = "s1";
const option = (n) => ({
  option: n,
  title: `Look ${n}`,
  summary: `Summary ${n}`,
  items: [{ category: "top", name: "Crew tee", colorName: "Cream", hex: "#EFE3C6" }],
});
const run = (events, start = sessionReducer(initialState, { type: "session/started", sessionId: ID, status: "waiting_for_capture" })) =>
  events.reduce((state, event) => sessionReducer(state, { type: "event", event: { sessionId: ID, ...event }, now: 1000 }), start);

test("a whole visit: capture, colours, options, the first look", () => {
  const state = run([
    { type: "session.status", status: "analyzing", message: "Analysing your photo…" },
    { type: "session.skin", skinUndertone: "warm", skinUndertoneSource: "measured", skinMeasurement: { skinHex: "#C68E6A", statement: "Golden.", styling: { best_metals: ["gold"] } }, palette: [{ name: "Rust", hex: "#B7410E" }] },
    { type: "session.profile", profile: { skinUndertone: "warm", skinUndertoneSource: "measured", skinMeasurement: { skinHex: "#C68E6A", statement: "Golden.", requireConfirmation: true, styling: { best_metals: ["gold"] } } }, palette: [{ name: "Olive", hex: "#708238" }], fitGuidance: ["Straight cuts."] },
    { type: "session.option", round: 1, option: option(1) },
    { type: "session.render.started", round: 1, option: 1 },
    { type: "session.option", round: 1, option: option(2) },
    { type: "session.render.done", round: 1, option: 1, imageDataUrl: "data:image/png;base64,AAA", faceCheck: { passed: true } },
  ]);
  const s = state.session;
  assert.equal(phaseOf(s), "results");
  assert.equal(activeOption(s).title, "Look 1");
  assert.equal(activeRender(s).imageDataUrl, "data:image/png;base64,AAA");
  assert.equal(s.rounds[1].length, 2);
  const view = undertoneView(s);
  assert.equal(view.undertone, "warm");
  assert.equal(view.sure, true);
  assert.equal(view.palette[0].name, "Olive", "the profile's palette replaces the early one");
  assert.equal(view.needsConfirmation, true);
  assert.deepEqual(view.metals, ["gold"]);
  const confirmed = run([{ type: "session.profile.confirmed" }], state);
  assert.equal(undertoneView(confirmed.session).needsConfirmation, false);
});

test("events for another visitor's session are ignored", () => {
  const state = run([{ type: "session.status", status: "designing" }]);
  const other = sessionReducer(state, { type: "event", event: { type: "session.ended", sessionId: "someone-else", reason: "timeout" } });
  assert.equal(other.session.ended, null);
  assert.equal(other.session.status, "designing");
});

test("a background prefetch doesn't replace the look on screen", () => {
  const state = run([
    { type: "session.option", round: 1, option: option(1) },
    { type: "session.option", round: 1, option: option(2) },
    { type: "session.render.started", round: 1, option: 1 },
    { type: "session.render.done", round: 1, option: 1, imageDataUrl: "data:one" },
    { type: "session.render.started", round: 1, option: 2, prefetch: true },
    { type: "session.render.done", round: 1, option: 2, imageDataUrl: "data:two", prefetch: true },
  ]);
  assert.deepEqual(state.session.active, { round: 1, option: 1 });
  assert.equal(state.session.renders["1.2"].status, "done");
});

test("a clearer face on a shown look swaps the picture; a stream without images keeps the old one", () => {
  const shown = run([
    { type: "session.option", round: 1, option: option(1) },
    { type: "session.render.done", round: 1, option: 1, imageDataUrl: "data:first" },
  ]);
  const upgraded = run([{ type: "session.render.done", round: 1, option: 1, imageDataUrl: "data:clearer", upgraded: true }], shown);
  assert.equal(activeRender(upgraded.session).imageDataUrl, "data:clearer");
  const redacted = run([{ type: "session.render.done", round: 1, option: 1, imageDataUrl: null }], shown);
  assert.equal(activeRender(redacted.session).imageDataUrl, "data:first");
});

test("a snapshot after a reconnect fills in what the stream missed", () => {
  const state = run([{ type: "session.status", status: "designing" }]);
  const merged = sessionReducer(state, {
    type: "session/snapshot",
    snapshot: {
      sessionId: ID,
      status: "ready",
      profile: { skinUndertone: "cool", skinUndertoneSource: "measured" },
      palette: [{ name: "Navy", hex: "#1F2A44" }],
      rounds: [{ round: 1, options: [option(1), option(2), option(3)] }],
      renders: [{ key: "1.2", round: 1, option: 2, status: "done", imageDataUrl: "data:two" }],
      activeKey: "1.2",
      degraded: null,
    },
  });
  assert.equal(merged.session.status, "ready");
  assert.equal(activeOption(merged.session).title, "Look 2");
  assert.equal(activeRender(merged.session).imageDataUrl, "data:two");
  assert.equal(undertoneView(merged.session).undertone, "cool");
  const stale = sessionReducer(state, { type: "session/snapshot", snapshot: { sessionId: "old", status: "ready" } });
  assert.equal(stale.session.status, "designing", "a snapshot of another session is ignored");
});

test("text-only mode, failures, keeping a look, and the end of a visit", () => {
  let state = run([
    { type: "session.option", round: 1, option: option(1) },
    { type: "session.render.started", round: 1, option: 1 },
    { type: "session.degraded", message: "Pictures are unavailable today." },
    { type: "session.render.failed", round: 1, option: 1, error: "Couldn't draw that one." },
  ]);
  assert.equal(state.session.degraded.message, "Pictures are unavailable today.");
  assert.equal(activeRender(state.session).status, "failed");
  assert.equal(state.session.error, "Couldn't draw that one.");
  state = run([{ type: "session.recovered" }, { type: "session.kept", round: 1, option: 1, url: "https://x/looks/t", qrDataUrl: "data:qr" }], state);
  assert.equal(state.session.degraded, null);
  assert.equal(state.session.kept.qrDataUrl, "data:qr");
  state = run([{ type: "session.ended", reason: "visitor_left" }], state);
  assert.equal(phaseOf(state.session), "ended");
  assert.equal(sessionReducer(state, { type: "session/cleared" }).session, null);
});

test("an error before any looks is an error screen; after looks, the looks stay", () => {
  assert.equal(phaseOf(run([{ type: "session.error", error: "Camera problem." }]).session), "error");
  const withLooks = run([{ type: "session.option", round: 1, option: option(1) }, { type: "session.error", error: "Later problem." }]);
  assert.equal(phaseOf(withLooks.session), "results");
});

test("the countdown runs from the last perception event, 3-2-1, and only when armed", () => {
  const state = sessionReducer(initialState, {
    type: "event",
    event: { type: "perception", state: "ready", ready: true, armed: true, heldMs: 0, holdMs: 3000 },
    now: 10_000,
  });
  assert.equal(countdown(state.perception, 10_000), 3);
  assert.equal(countdown(state.perception, 11_100), 2);
  assert.equal(countdown(state.perception, 12_500), 1);
  assert.equal(countdown(state.perception, 14_000), 1, "never shows 0 while the capture is on its way");
  const notArmed = sessionReducer(state, { type: "event", event: { type: "perception", state: "ready", ready: true, armed: false, heldMs: 0, holdMs: 3000 }, now: 0 });
  assert.equal(countdown(notArmed.perception, 0), null);
});

test("connection and camera state", () => {
  let state = sessionReducer(initialState, { type: "event", event: { type: "hello", sidecar: "running" } });
  assert.equal(state.connection, "open");
  assert.equal(state.camera, "running");
  state = sessionReducer(state, { type: "event", event: { type: "camera", status: "error" } });
  assert.equal(state.camera, "error");
  state = sessionReducer(state, { type: "connection", status: "unauthorized" });
  assert.equal(state.connection, "unauthorized");
});
