import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activeOption,
  activeRender,
  cartCount,
  cartSubtotal,
  countdown,
  DEFAULT_PRICE_RANGE,
  editsForLook,
  emptyShop,
  initialState,
  phaseOf,
  sessionReducer,
  undertoneView,
} from "./sessionReducer.js";

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

const product = (overrides = {}) => ({
  id: "p1",
  name: "Crew tee",
  category: "top",
  price: 1299,
  stock: 3,
  sizes: ["UK 6", "UK 8"],
  outOfStockSizes: [],
  ...overrides,
});

test("the cart adds, caps at stock, changes size, and totals", () => {
  let state = sessionReducer(initialState, { type: "shop/cartAdded", product: product(), size: "UK 8", qty: 2 });
  assert.equal(state.shop.cart.length, 1);
  assert.equal(state.shop.cart[0].size, "UK 8");
  assert.equal(cartCount(state.shop), 2);
  state = sessionReducer(state, { type: "shop/cartAdded", product: product(), qty: 5 });
  assert.equal(state.shop.cart[0].qty, 3, "never more than stock");
  assert.equal(state.shop.cart[0].size, "UK 8", "keeps the chosen size when re-adding");
  state = sessionReducer(state, { type: "shop/cartQty", id: "p1", qty: 99 });
  assert.equal(state.shop.cart[0].qty, 3);
  state = sessionReducer(state, { type: "shop/cartSize", id: "p1", size: "UK 6" });
  assert.equal(state.shop.cart[0].size, "UK 6");
  assert.equal(cartSubtotal(state.shop), 1299 * 3);
  state = sessionReducer(state, { type: "shop/cartRemoved", id: "p1" });
  assert.equal(state.shop.cart.length, 0);
  assert.equal(cartCount(state.shop), 0);
});

test("an out-of-stock product can't be added", () => {
  const state = sessionReducer(initialState, { type: "shop/cartAdded", product: product({ stock: 0 }) });
  assert.equal(state.shop.cart.length, 0);
});

test("filters normalise the price range and clear", () => {
  let state = sessionReducer(initialState, { type: "shop/filtersSet", from: 5000, to: 1500 });
  assert.deepEqual(state.shop.filters, { from: 1500, to: 5000 });
  state = sessionReducer(state, { type: "shop/filtersSet", from: -100, to: 0 });
  assert.deepEqual(state.shop.filters, { from: 0, to: 0 });
  state = sessionReducer(state, { type: "shop/filtersCleared" });
  assert.deepEqual(state.shop.filters, DEFAULT_PRICE_RANGE);
});

test("saved outfits and piece edits stay in the visit", () => {
  let state = sessionReducer(initialState, {
    type: "shop/outfitSaved",
    key: "1.2",
    round: 1,
    option: 2,
    title: "Look 2",
    items: [{ category: "top", name: "Crew tee" }],
    imageDataUrl: "data:look",
  });
  assert.equal(state.shop.saved[0].imageDataUrl, "data:look");
  state = sessionReducer(state, { type: "shop/pieceEdited", key: "1.2", category: "top", product: product({ id: "r1" }) });
  assert.equal(editsForLook(state.shop, "1.2").top.id, "r1");
  assert.equal(editsForLook(state.shop, "9.9").top, undefined);
  state = sessionReducer(state, { type: "shop/pieceEdited", key: "1.2", category: "top", product: null });
  assert.equal(editsForLook(state.shop, "1.2").top, undefined);
});

test("the shop is dropped when a visit starts, ends, or is cleared", () => {
  const live = sessionReducer(initialState, { type: "session/started", sessionId: ID });
  const shopping = sessionReducer(
    sessionReducer(live, { type: "shop/cartAdded", product: product() }),
    { type: "shop/outfitSaved", key: "1.1", title: "Look 1" },
  );
  const started = sessionReducer(shopping, { type: "session/started", sessionId: "s2" });
  assert.deepEqual(started.shop, emptyShop());
  const ended = run([{ type: "session.ended", reason: "done" }], shopping);
  assert.deepEqual(ended.shop, emptyShop(), "privacy: nothing survives the visit");
  const cleared = sessionReducer(shopping, { type: "session/cleared" });
  assert.deepEqual(cleared.shop, emptyShop());
});

test("the visit remembers the visitor's gender from their picks", () => {
  const started = sessionReducer(initialState, { type: "session/started", sessionId: "s1", status: "waiting_for_capture", gender: "female" });
  assert.equal(started.session.gender, "female");
  assert.equal(sessionReducer(initialState, { type: "session/started", sessionId: "s2" }).session.gender, null);
});

test("a visitor's undertone correction counts as known, clears olive, and settles the question", () => {
  let state = sessionReducer(initialState, { type: "session/started", sessionId: "s1" });
  const measurement = { requireConfirmation: true, warmCool: { olive: true } };
  const profileEvent = (profile) => ({ type: "event", event: { type: "session.profile", sessionId: "s1", profile, palette: [] } });
  state = sessionReducer(state, profileEvent({ skinUndertone: "warm", skinUndertoneSource: "measured", olive: true, skinMeasurement: measurement }));
  let view = undertoneView(state.session);
  assert.equal(view.sure, true);
  assert.equal(view.olive, true);
  assert.equal(view.needsConfirmation, true, "an unsure reading asks");
  state = sessionReducer(state, profileEvent({ skinUndertone: "cool", skinUndertoneSource: "visitor", olive: false, skinMeasurement: measurement }));
  view = undertoneView(state.session);
  assert.deepEqual([view.undertone, view.sure, view.olive, view.needsConfirmation], ["cool", true, false, false]);
  state = sessionReducer(state, profileEvent({ skinUndertone: "neutral", skinUndertoneSource: "fallback", olive: false, skinMeasurement: null }));
  assert.equal(undertoneView(state.session).sure, false, "a fallback is still unsure");
});
