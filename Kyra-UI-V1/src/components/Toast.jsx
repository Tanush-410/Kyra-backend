import "./Toast.css";

/**
 * A short message under the header: "Outfit added to cart", "Item discarded", "Please try again".
 * Figma: "Success" (2043:13431) and the error pill in "Error" (2043:13413).
 *
 * Two ways to use it:
 *   <Toast kind="error">Please try again</Toast>
 *   const { toast, showToast } = useToast();  showToast("Item discarded");  <Toast toast={toast} />
 *     (hooks/useToast.js: the message goes after TOAST_MS; toast is null when there is none)
 *
 * The icons are stand-ins drawn here: the Figma ones (charm:tick 2043:13434, and the error icon in
 * 2043:13414) could not be exported when this was built (Figma call limit). Replace them with the exports.
 */
export default function Toast({ kind, children, toast }) {
  if (toast === null) return null;
  const tone = (toast?.kind || kind) === "error" ? "error" : "success";
  const text = toast ? toast.message : children;
  return (
    <div key={toast?.id} className={`toast toast--${tone}`} role={tone === "error" ? "alert" : "status"}>
      <span className="toast__icon" aria-hidden="true">
        {tone === "error" ? (
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
      <span className="toast__text">{text}</span>
    </div>
  );
}

/** How long a message stays. Figma note: "The confirmation message stays on the mirror for 3 seconds". */
export const TOAST_MS = 3000;
