import { useCallback, useEffect, useRef, useState } from "react";
import "./Toast.css";

/**
 * A short message under the header: "Outfit added to cart", "Item discarded", "Please try again".
 * Figma: "Success" (2043:13431) and the error pill in "Error" (2043:13413).
 *
 * The icons are stand-ins drawn here: the Figma ones (charm:tick 2043:13434, and the error icon in
 * 2043:13414) could not be exported when this was built (Figma call limit). Replace them with the exports.
 */
export default function Toast({ kind = "success", children }) {
  return (
    <div className={`toast toast--${kind}`} role={kind === "error" ? "alert" : "status"}>
      <span className="toast__icon" aria-hidden="true">
        {kind === "error" ? (
          <svg viewBox="0 0 27 27" width="27" height="27">
            <path d="M13.5 5v10" stroke="#000" strokeWidth="3.4" strokeLinecap="round" />
            <circle cx="13.5" cy="21" r="2" fill="#000" />
          </svg>
        ) : (
          <svg viewBox="0 0 27 27" width="27" height="27">
            <path d="M5 14l5.5 5.5L22 8" fill="none" stroke="#000" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      <span className="toast__text">{children}</span>
    </div>
  );
}

/** How long a message stays. Figma note: "The confirmation message stays on the mirror for 3 seconds". */
export const TOAST_MS = 3000;

/**
 * const [toast, showToast] = useToast();
 * showToast("Outfit added to cart") or showToast("Please try again", "error"); render {toast}.
 */
export function useToast(durationMs = TOAST_MS) {
  const [message, setMessage] = useState(null);
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  const show = useCallback(
    (text, kind = "success") => {
      clearTimeout(timer.current);
      setMessage({ text, kind, id: Date.now() });
      timer.current = setTimeout(() => setMessage(null), durationMs);
    },
    [durationMs]
  );
  const toast = message ? (
    <Toast key={message.id} kind={message.kind}>
      {message.text}
    </Toast>
  ) : null;
  return [toast, show];
}
