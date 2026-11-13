import { useEffect, useRef } from "react";
import { useHandTracking } from "../context/HandTrackingContext.jsx";

/**
 * Hand swipes for this screen: onSwipe("left" | "right"). Swipes are only detected while a screen uses
 * this (Suggestions), with the thresholds in lib/handGestures.js.
 */
export function useHandSwipe(onSwipe) {
  const { registerSwipe } = useHandTracking();
  const ref = useRef(onSwipe);
  ref.current = onSwipe;
  useEffect(() => registerSwipe((direction) => ref.current?.(direction)), [registerSwipe]);
}

/** Calls onHold when a pinch is held on el (data-pinch-hold) for the full time. */
export function usePinchHold(ref, onHold) {
  const cb = useRef(onHold);
  cb.current = onHold;
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const listener = () => cb.current?.();
    el.addEventListener("pinchhold", listener);
    return () => el.removeEventListener("pinchhold", listener);
  }, [ref]);
}

/** Calls onDrop(target) when a pinch drags el (data-pinch-drag) onto a [data-drop] target ("cart", "bin"). */
export function usePinchDrop(ref, onDrop) {
  const cb = useRef(onDrop);
  cb.current = onDrop;
  useEffect(() => {
    // Listened for at the document (the event bubbles), so the element may appear after this screen opens:
    // the try-on picture arrives when its render is done.
    const listener = (e) => {
      const el = ref.current;
      if (el && e.target instanceof Node && el.contains(e.target)) cb.current?.(e.detail?.target);
    };
    document.addEventListener("pinchdrop", listener);
    return () => document.removeEventListener("pinchdrop", listener);
  }, [ref]);
}
