/**
 * The mirror's state, built from the backend's event stream (and a snapshot after a reconnect).
 * Pure: no timers, no fetches, so every case is unit-tested (sessionReducer.test.js).
 *
 * Event contract: backend INTEGRATION.md, section 4. The flow for one visitor:
 *   session.status waiting_for_capture -> (camera captures) -> session.skin -> session.profile
 *   -> session.option x3 -> session.render.started -> session.render.done (the look) -> ...
 */

export const initialState = {
  connection: "connecting", // connecting | open | reconnecting | unauthorized
  camera: "unknown", // the backend camera: running | starting | disabled | error | unavailable | unknown
  perception: null, // { state, message, ready, heldMs, holdMs, armed, receivedAt }
  present: null,
  session: null,
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

export function sessionReducer(state, action) {
  switch (action.type) {
    case "connection":
      return { ...state, connection: action.status };
    case "session/started":
      return { ...state, session: newSession(action.sessionId, action.status) };
    case "session/cleared":
      return { ...state, session: null };
    case "session/snapshot":
      return state.session && state.session.id === action.snapshot.sessionId
        ? { ...state, session: mergeSnapshot(state.session, action.snapshot) }
        : state;
    case "session/actionFailed":
      return state.session ? { ...state, session: { ...state.session, actionError: action.message } } : state;
    case "session/actionCleared":
      return state.session ? { ...state, session: { ...state.session, actionError: "" } } : state;
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
      return { ...state, session: sessionEvent(state.session, event) };
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

/** The screen to show for this session: "capture" | "working" | "results" | "error" | "ended". */
export function phaseOf(session) {
  if (!session) return "none";
  if (session.ended) return "ended";
  if (session.status === "error" && !Object.keys(session.rounds).length) return "error";
  if (session.status === "waiting_for_capture") return "capture";
  return "results";
}
