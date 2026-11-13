import { activeOption, activeRender } from "../state/sessionReducer.js";
import "./LookShortcut.css";

/** What the look rendering in the background is doing, in a few words. */
export function lookStatus(session) {
  const render = activeRender(session);
  if (session?.degraded) return { ready: true, text: "Your looks are ready" };
  if (render?.status === "done") return { ready: true, text: "Your look is ready" };
  if (render?.status === "failed") return { ready: true, text: "Your looks are ready" };
  if (activeOption(session)) return { ready: false, text: "Kyra is creating your look…" };
  return { ready: false, text: "Kyra is designing your looks…" };
}

/**
 * Not in the Figma frames: the look renders in the background while the visitor reads their colours
 * and fit, and this lets them skip straight to it. label: the button text (defaults by status).
 */
export default function LookShortcut({ session, onOpen, label, primary = false }) {
  const status = lookStatus(session);
  return (
    <div className="look-shortcut">
      <p className={`look-shortcut__status${status.ready ? " look-shortcut__status--ready" : ""}`} role="status">
        {status.text}
      </p>
      <button type="button" className={primary ? "option-card option-card--w840" : "outline-button"} onClick={onOpen}>
        {label || (status.ready ? "See my look" : "Skip to my look")}
      </button>
    </div>
  );
}
