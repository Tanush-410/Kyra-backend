/**
 * The mirror's state, built from the backend's event stream (and a snapshot after a reconnect).
 * Pure: no timers, no fetches, so every case is unit-tested (sessionReducer.test.js).
 *
 * Event contract: backend INTEGRATION.md, section 4. The flow for one visitor:
 *   session.status waiting_for_capture -> (camera captures) -> session.skin -> session.profile
 *   -> session.option x3 -> session.render.started -> session.render.done (the look) -> ...
 */

export const DEFAULT_PRICE_RANGE = { from: 0, to: 10000 };

/** The shop slice is frontend-only and is dropped with the visit (privacy: nothing outlives "I'm done"). */
export function emptyShop() {
  return { cart: [], saved: [], filters: { ...DEFAULT_PRICE_RANGE }, edits: {} };
}

export const initialState = {
  connection: "connecting", // connecting | open | reconnecting | unauthorized
  camera: "unknown", // the backend camera: running | starting | disabled | error | unavailable | unknown
  perception: null, // { state, message, ready, heldMs, holdMs, armed, receivedAt }
  present: null,
  session: null,
  shop: emptyShop(),
};

export const keyOf = (round, option) => `${round}.${option}`;

function newSession(sessionId, status) {
  return {
    id: sessionId,
    status: status || "waiting_for_capture",
    message: "",
    skin: null, // the early undertone reading (from the face, before the body capture)
    profile: null,
    palette: [],
    neutrals: [],
    fitGuidance: [],
    profileConfirmed: false,
    rounds: {}, // round number -> options[]
    currentRound: 0,
    renders: {}, // "round.option" -> { status, imageDataUrl, preview, faceCheck, error, position }
    active: null, // { round, option }: the look on screen
    ratings: {},
    kept: null, // { url, qrDataUrl, expiresAt }
    degraded: null, // { message }: images are unavailable, the looks are shown as text
    error: "",
    ended: null, // reason
    actionError: "",
  };
}

function patchRender(session, round, option, patch) {
  const key = keyOf(round, option);
  return { ...session.renders, [key]: { ...(session.renders[key] || {}), ...patch } };
}

function upsertOption(options = [], option) {
  const rest = options.filter((o) => o.option !== option.option);
  return [...rest, option].sort((a, b) => a.option - b.option);
}

function sessionEvent(session, event) {
  const { round, option } = event;
  switch (event.type) {
    case "session.status":
      return { ...session, status: event.status, message: event.message || "" };
    case "session.skin":
      return { ...session, skin: event, palette: session.profile ? session.palette : event.palette || [] };
    case "session.profile":
      return {
        ...session,
        profile: event.profile,
        palette: event.palette || [],
        neutrals: event.neutrals || [],
        fitGuidance: event.fitGuidance || [],
      };
    case "session.profile.confirmed":
      return { ...session, profileConfirmed: true };
    case "session.option":
      return {
        ...session,
        rounds: { ...session.rounds, [round]: upsertOption(session.rounds[round], event.option) },
        currentRound: Math.max(session.currentRound, round),
      };
    case "session.options":
      return { ...session, rounds: { ...session.rounds, [round]: event.options }, currentRound: Math.max(session.currentRound, round) };
    case "session.render.queued":
      return { ...session, renders: patchRender(session, round, option, { status: "queued", position: event.position }) };
    case "session.render.started":
      return {
        ...session,
        renders: patchRender(session, round, option, { status: "rendering", error: "" }),
        // A prefetch renders the next look in the background: it doesn't change what's on screen.
        active: event.prefetch ? session.active : { round, option },
        error: event.prefetch ? session.error : "",
      };
    case "session.render.draft":
    case "session.render.partial":
      return event.imageDataUrl ? { ...session, renders: patchRender(session, round, option, { preview: event.imageDataUrl }) } : session;
    case "session.render.done": {
      const before = session.renders[keyOf(round, option)] || {};
      const renders = patchRender(session, round, option, {
        status: "done",
        // A stream without images (not scoped yet) sends null: keep what we have; the snapshot fills it.
        imageDataUrl: event.imageDataUrl || before.imageDataUrl || null,
        faceCheck: event.faceCheck ?? before.faceCheck ?? null,
        error: "",
      });
      if (event.upgraded) return { ...session, renders }; // a clearer face on a look already shown
      const isActive = session.active && keyOf(session.active.round, session.active.option) === keyOf(round, option);
      return { ...session, renders, active: event.prefetch && !isActive ? session.active : { round, option } };
    }
    case "session.render.failed":
      return {
        ...session,
        renders: patchRender(session, round, option, { status: "failed", error: event.error || "" }),
        error: event.prefetch ? session.error : event.error || "",
      };
    case "session.rated":
      return { ...session, ratings: { ...session.ratings, [keyOf(round, option)]: event.rating } };
    case "session.kept":
      return { ...session, kept: { url: event.url, qrDataUrl: event.qrDataUrl, expiresAt: event.expiresAt, round, option } };
    case "session.degraded":
      return { ...session, degraded: { message: event.message || "" } };
    case "session.recovered":
      return { ...session, degraded: null };
    case "session.error":
      return { ...session, status: "error", error: event.error || "" };
    case "session.ended":
      return { ...session, ended: event.reason || "ended" };
    default:
      return session;
  }
}

/** Merges GET /api/v2/sessions/:id into what the events built (after a reconnect, or a stream without images). */
function mergeSnapshot(session, snapshot) {
  const rounds = { ...session.rounds };
  for (const round of snapshot.rounds || []) {
    if (round.options?.length) rounds[round.round] = round.options;
  }
  const renders = { ...session.renders };
  for (const render of snapshot.renders || []) {
    const before = renders[render.key] || {};
    renders[render.key] = {
      ...before,
      status: render.status,
      imageDataUrl: render.imageDataUrl || before.imageDataUrl || null,
      faceCheck: render.faceCheck ?? before.faceCheck ?? null,
      error: render.error || "",
    };
  }
  let active = session.active;
  if (snapshot.activeKey) {
    const [round, option] = snapshot.activeKey.split(".").map(Number);
    active = { round, option };
  }
  const roundNumbers = Object.keys(rounds).map(Number);
  return {
    ...session,
    status: snapshot.status || session.status,
    profile: snapshot.profile || session.profile,
    palette: snapshot.palette || session.palette,
    neutrals: snapshot.neutrals || session.neutrals,
    fitGuidance: snapshot.fitGuidance || session.fitGuidance,
    rounds,
    currentRound: roundNumbers.length ? Math.max(...roundNumbers) : session.currentRound,
    renders,
    active,
    degraded: snapshot.degraded ?? session.degraded,
  };
}

function clampQty(value, stock) {
  const limit = Math.max(1, Number(stock) || 1);
  return Math.max(1, Math.min(limit, Math.round(Number(value) || 1)));
}

function addToCart(shop, action) {
  const { product } = action;
  if (!product?.id || !product.stock || product.stock < 1) return shop;
  const explicitSize = action.size || null;
  const size = explicitSize || product.sizes?.[0] || "";
  const qty = clampQty(action.qty ?? 1, product.stock);
  const existing = shop.cart.find((line) => line.id === product.id);
  if (existing) {
    return {
      ...shop,
      cart: shop.cart.map((line) =>
        line.id === product.id
          ? { ...line, size: explicitSize || line.size, qty: clampQty(line.qty + qty, product.stock) }
          : line,
      ),
    };
  }
  return { ...shop, cart: [...shop.cart, { ...product, size, qty }] };
}

function setCartQty(shop, { id, qty }) {
  return {
    ...shop,
    cart: shop.cart.map((line) => (line.id === id ? { ...line, qty: clampQty(qty, line.stock) } : line)),
  };
}

function setCartSize(shop, { id, size }) {
  return {
    ...shop,
    cart: shop.cart.map((line) =>
      line.id === id ? { ...line, size: size || line.size, qty: clampQty(line.qty, line.stock) } : line,
    ),
  };
}

function saveOutfit(shop, action) {
  const key = action.key;
  if (!key) return shop;
  const outfit = {
    key,
    round: action.round,
    option: action.option,
    title: action.title || "",
    summary: action.summary || "",
    items: action.items || [],
    imageDataUrl: action.imageDataUrl || null,
  };
  const rest = shop.saved.filter((entry) => entry.key !== key);
  return { ...shop, saved: [...rest, outfit] };
}

function setFilters(shop, { from, to }) {
  let nextFrom = Math.max(0, Math.round(Number(from) || 0));
  let nextTo = Math.max(0, Math.round(Number(to) || 0));
  if (nextFrom > nextTo) [nextFrom, nextTo] = [nextTo, nextFrom];
  return { ...shop, filters: { from: nextFrom, to: nextTo } };
}

function editPiece(shop, { key, category, product }) {
  if (!key || !category) return shop;
  const editKey = `${key}|${category}`;
  const edits = { ...shop.edits };
  if (product) edits[editKey] = product;
  else delete edits[editKey];
  return { ...shop, edits };
}

export function sessionReducer(state, action) {
  switch (action.type) {
    case "connection":
      return { ...state, connection: action.status };
    case "session/started":
      return { ...state, session: newSession(action.sessionId, action.status), shop: emptyShop() };
    case "session/cleared":
      return { ...state, session: null, shop: emptyShop() };
    case "session/snapshot":
      return state.session && state.session.id === action.snapshot.sessionId
        ? { ...state, session: mergeSnapshot(state.session, action.snapshot) }
        : state;
    case "session/actionFailed":
      return state.session ? { ...state, session: { ...state.session, actionError: action.message } } : state;
    case "session/actionCleared":
      return state.session ? { ...state, session: { ...state.session, actionError: "" } } : state;
    case "shop/cleared":
      return { ...state, shop: emptyShop() };
    case "shop/cartAdded":
      return { ...state, shop: addToCart(state.shop, action) };
    case "shop/cartRemoved":
      return { ...state, shop: { ...state.shop, cart: state.shop.cart.filter((line) => line.id !== action.id) } };
    case "shop/cartQty":
      return { ...state, shop: setCartQty(state.shop, action) };
    case "shop/cartSize":
      return { ...state, shop: setCartSize(state.shop, action) };
    case "shop/outfitSaved":
      return { ...state, shop: saveOutfit(state.shop, action) };
    case "shop/outfitRemoved":
      return { ...state, shop: { ...state.shop, saved: state.shop.saved.filter((entry) => entry.key !== action.key) } };
    case "shop/filtersSet":
      return { ...state, shop: setFilters(state.shop, action) };
    case "shop/filtersCleared":
      return { ...state, shop: { ...state.shop, filters: { ...DEFAULT_PRICE_RANGE } } };
    case "shop/pieceEdited":
      return { ...state, shop: editPiece(state.shop, action) };
    case "event":
      return applyEvent(state, action.event, action.now ?? 0);
    default:
      return state;
  }
}

function applyEvent(state, event, now) {
  switch (event.type) {
    case "hello":
      return { ...state, connection: "open", camera: event.sidecar || state.camera };
    case "camera":
      return { ...state, camera: event.status };
    case "perception":
      return {
        ...state,
        perception: {
          state: event.state,
          message: event.message || "",
          ready: Boolean(event.ready),
          heldMs: Number(event.heldMs) || 0,
          holdMs: Number(event.holdMs) || 0,
          armed: Boolean(event.armed),
          receivedAt: now,
        },
      };
    case "presence":
      return { ...state, present: Boolean(event.present) };
    default:
      if (!event.type?.startsWith("session.")) return state;
      // Another visitor's session (a stale tab, an operator's console): not ours.
      if (!state.session || event.sessionId !== state.session.id) return state;
      return {
        ...state,
        session: sessionEvent(state.session, event),
        ...(event.type === "session.ended" ? { shop: emptyShop() } : null),
      };
  }
}

// ---- selectors -----------------------------------------------------------------------------------

export function activeOption(session) {
  if (!session?.active) return session?.rounds[session.currentRound]?.[0] || null;
  return session.rounds[session.active.round]?.find((o) => o.option === session.active.option) || null;
}

export function activeRender(session) {
  if (!session?.active) return null;
  return session.renders[keyOf(session.active.round, session.active.option)] || null;
}

/**
 * What to say about the visitor's colouring. The full profile once it exists, else the early reading.
 * sure: the undertone was measured clearly (not a neutral fallback).
 */
export function undertoneView(session) {
  if (!session) return null;
  const profile = session.profile;
  const skin = session.skin;
  if (!profile && !skin) return null;
  const undertone = profile?.skinUndertone || skin?.skinUndertone || null;
  const source = profile?.skinUndertoneSource || skin?.skinUndertoneSource || null;
  const measurement = profile?.skinMeasurement || skin?.skinMeasurement || null;
  return {
    undertone,
    sure: source === "measured",
    olive: Boolean(measurement?.warmCool?.olive ?? skin?.olive),
    skinHex: measurement?.skinHex || null,
    statement: measurement?.statement || "",
    metals: measurement?.styling?.best_metals || [],
    needsConfirmation: Boolean(profile && measurement?.requireConfirmation && !session.profileConfirmed),
    palette: session.palette || [],
  };
}

/**
 * The 3-2-1 for the hold-still screen. Perception events come when the state changes (and as a
 * heartbeat), so the count is worked out from the last event and the time since it arrived.
 */
export function countdown(perception, now) {
  if (!perception?.ready || !perception.armed || !perception.holdMs) return null;
  const held = perception.heldMs + Math.max(0, now - perception.receivedAt);
  const left = perception.holdMs - held;
  return Math.max(1, Math.ceil(left / 1000));
}

export function cartCount(shop) {
  return (shop?.cart || []).reduce((total, line) => total + (Number(line.qty) || 0), 0);
}

export function cartSubtotal(shop) {
  return (shop?.cart || []).reduce((total, line) => total + (Number(line.price) || 0) * (Number(line.qty) || 0), 0);
}

/** The replacement pieces chosen for one look, keyed by category. */
export function editsForLook(shop, key) {
  const edits = {};
  for (const [editKey, product] of Object.entries(shop?.edits || {})) {
    const [lookKey, category] = editKey.split("|");
    if (lookKey === key) edits[category] = product;
  }
  return edits;
}

/** The screen to show for this session: "capture" | "working" | "results" | "error" | "ended". */
export function phaseOf(session) {
  if (!session) return "none";
  if (session.ended) return "ended";
  if (session.status === "error" && !Object.keys(session.rounds).length) return "error";
  if (session.status === "waiting_for_capture") return "capture";
  return "results";
}
