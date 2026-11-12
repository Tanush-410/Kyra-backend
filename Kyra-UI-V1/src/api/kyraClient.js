import { API_BASE, getToken } from "../config.js";

/**
 * The KYRA backend's mirror API (v2). The full contract is in the backend repo's INTEGRATION.md, section 4.
 * Requests send the kiosk token as a Bearer header; EventSource and <img> cannot send headers, so those
 * pass it as ?token= (the backend redacts it from its logs).
 */

export class KyraApiError extends Error {
  constructor(message, { status = 0, code = "" } = {}) {
    super(message);
    this.name = "KyraApiError";
    this.status = status;
    this.code = code;
  }
}

const VISITOR_FALLBACK = "Something went wrong. Please try again.";

async function request(path, { method = "GET", body, keepalive = false } = {}) {
  const token = getToken();
  const headers = {
    ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      keepalive, // lets a request finish while the page closes
    });
  } catch {
    throw new KyraApiError("I can't reach the mirror right now. Please try again in a moment.", { code: "offline" });
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new KyraApiError(data.error || VISITOR_FALLBACK, { status: response.status, code: data.code || "" });
  }
  return data;
}

const session = (id) => `/api/v2/sessions/${encodeURIComponent(id)}`;

export const kyraApi = {
  /** { style, gender?, heightCm?, preferences?, imageDataUrl?, consent: true } -> { sessionId, status } */
  startSession: (body) => request("/api/v2/sessions", { method: "POST", body }),
  getSession: (id) => request(session(id)),
  render: (id, round, option) => request(`${session(id)}/render`, { method: "POST", body: { round, option } }),
  next: (id) => request(`${session(id)}/next`, { method: "POST", body: {} }),
  rate: (id, { round, option, rating }) => request(`${session(id)}/rate`, { method: "POST", body: { round, option, rating } }),
  keep: (id, { round, option }) => request(`${session(id)}/keep`, { method: "POST", body: { round, option } }),
  confirmProfile: (id) => request(`${session(id)}/profile/confirm`, { method: "POST", body: {} }),
  /** corrections: any of { skinUndertone, skinDepth, heightCm, build } */
  correctProfile: (id, corrections) => request(`${session(id)}/profile`, { method: "POST", body: corrections }),
  endSession: (id, { keepalive = false } = {}) => request(session(id), { method: "DELETE", keepalive }),
  /** 401 means the kiosk token is missing or wrong (an EventSource can't tell us that itself). */
  tokenAccepted: async () => {
    try {
      await request("/api/v2/sessions/check-token");
      return true;
    } catch (error) {
      return error.status !== 401;
    }
  },
};

function withToken(path, params = {}) {
  const token = getToken();
  const query = new URLSearchParams({ ...(token ? { token } : {}), ...params });
  const text = query.toString();
  return `${API_BASE}${path}${text ? `?${text}` : ""}`;
}

/** The backend camera's live preview (MJPEG), already mirrored like a real mirror. */
export const previewUrl = () => withToken("/api/v2/preview.mjpg");

export const EVENT_TYPES = [
  "hello",
  "camera",
  "perception",
  "presence",
  "gesture",
  "budget.warning",
  "session.status",
  "session.skin",
  "session.profile",
  "session.profile.confirmed",
  "session.option",
  "session.options",
  "session.render.queued",
  "session.render.started",
  "session.render.draft",
  "session.render.partial",
  "session.render.done",
  "session.render.failed",
  "session.rated",
  "session.kept",
  "session.gesture",
  "session.degraded",
  "session.recovered",
  "session.error",
  "session.ended",
  "session.subject",
];

/**
 * Opens the event stream. With a sessionId the stream is scoped to that visitor and carries their
 * images; without one it carries camera guidance only. Returns a function that closes it.
 */
export function openEvents({ sessionId = null, onEvent, onOpen, onError }) {
  const source = new EventSource(withToken("/api/v2/events", sessionId ? { sessionId } : {}));
  source.onopen = () => onOpen?.();
  source.onerror = () => onError?.({ closed: source.readyState === EventSource.CLOSED });
  for (const type of EVENT_TYPES) {
    source.addEventListener(type, (message) => {
      try {
        onEvent(JSON.parse(message.data));
      } catch (error) {
        console.warn("[kyra] bad event", type, error);
      }
    });
  }
  return () => source.close();
}
