/**
 * How this UI reaches the KYRA backend. Everything comes from build-time env (see .env.example).
 *
 * VITE_KYRA_API_URL   Backend address. Empty (the default) = same origin: the backend serves this UI at
 *                     /Kyra-UI-V1/, and `npm run dev` proxies /api to it, so the browser never needs CORS.
 * VITE_KYRA_TOKEN     Kiosk token for local development only. On the mirror, open the link from
 *                     `npm run links` (backend): its #token=... is read once and kept in localStorage.
 * VITE_CAMERA_SOURCE  "backend" (default): the backend's camera does the capture, and this UI shows its
 *                     preview. "browser": this browser's webcam is used and the photo is uploaded
 *                     (for a UI running on a different machine than the camera).
 * VITE_SHOP_DEMO      On unless "false": the shop (products with prices, the cart on every screen from the
 *                     photo onwards, filter, checkout, piece edits). Its prices, sizes, brands and stock are
 *                     PLACEHOLDERS (src/data/shopPlaceholders.js) until a real product feed exists: set
 *                     "false" to hide them from visitors.
 */
const env = import.meta.env;

export const API_BASE = String(env.VITE_KYRA_API_URL || "").replace(/\/+$/, "");
export const CAMERA_SOURCE = env.VITE_CAMERA_SOURCE === "browser" ? "browser" : "backend";
export const SHOP_DEMO = env.VITE_SHOP_DEMO !== "false";

// Same key as the backend's test console, so one link sets up both on this machine.
const TOKEN_KEY = "kyraToken:kiosk";

/**
 * Reads #token=... from the address once, stores it, and removes it from the address bar (and so from
 * history and screenshots). Call before the router starts.
 */
export function captureTokenFromLink() {
  if (typeof window === "undefined") return;
  const fromLink = new URLSearchParams(window.location.hash.slice(1)).get("token");
  if (!fromLink) return;
  try {
    window.localStorage.setItem(TOKEN_KEY, fromLink);
  } catch {
    // storage blocked (private mode): the env token, if any, still works
  }
  window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
}

export function getToken() {
  try {
    return window.localStorage.getItem(TOKEN_KEY) || env.VITE_KYRA_TOKEN || "";
  } catch {
    return env.VITE_KYRA_TOKEN || "";
  }
}
