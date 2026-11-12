import { useCallback, useEffect, useRef, useState } from "react";
import { TOAST_MS } from "../components/Toast.jsx";

/**
 * const { toast, showToast } = useToast();
 * showToast("Outfit added to cart") or showToast("Please try again", "error"); render <Toast toast={toast} />.
 * The message disappears after TOAST_MS (3 s, from the Figma notes).
 */
export function useToast(duration = TOAST_MS) {
  const [toast, setToast] = useState(null);
  const timer = useRef(null);
  const nextId = useRef(0);

  const showToast = useCallback(
    (message, kind = "success") => {
      window.clearTimeout(timer.current);
      nextId.current += 1;
      setToast({ id: nextId.current, message, kind });
      timer.current = window.setTimeout(() => setToast(null), duration);
    },
    [duration]
  );

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return { toast, showToast };
}
