import { useCallback, useEffect, useRef, useState } from "react";

export function useToast(duration = 2600) {
  const [toast, setToast] = useState(null);
  const timer = useRef(null);
  const nextId = useRef(0);

  const showToast = useCallback(
    (message) => {
      window.clearTimeout(timer.current);
      nextId.current += 1;
      setToast({ id: nextId.current, message });
      timer.current = window.setTimeout(() => setToast(null), duration);
    },
    [duration]
  );

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return { toast, showToast };
}
