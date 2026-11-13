import { useEffect, useRef } from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router-dom";
import { useKyraSession } from "../context/KyraSessionContext.jsx";
import { OWN_CLICK, PINCH_EMPTY_EVENT, pinchBackTarget } from "../lib/pinchBack.js";
import { phaseOf } from "../state/sessionReducer.js";

export { PINCH_EMPTY_EVENT };

/**
 * "Pinch, click or tap anywhere that isn't a button to go back": keeps its own list of the screens visited (the browser's
 * history can't be read) so it can tell where back would land, and refuses where that would break a visit.
 * Renders nothing.
 */
export default function PinchBack() {
  const navigate = useNavigate();
  const location = useLocation();
  const type = useNavigationType();
  const { state } = useKyraSession();
  const phase = phaseOf(state.session);
  const stack = useRef([]);

  useEffect(() => {
    const path = location.pathname;
    const list = stack.current;
    if (type === "POP") {
      const at = list.lastIndexOf(path);
      if (at >= 0) list.length = at + 1;
      else list.push(path);
    } else if (type === "REPLACE" && list.length) list[list.length - 1] = path;
    else if (list[list.length - 1] !== path) list.push(path);
    if (path === "/") stack.current = ["/"]; // a new visit starts a new list
  }, [location.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const live = useRef({ phase });
  live.current = { phase };

  useEffect(() => {
    const goBack = (how) => {
      const target = pinchBackTarget({
        stack: stack.current,
        sessionActive: live.current.phase === "capture" || live.current.phase === "results",
        modalOpen: Boolean(document.querySelector("[inert]")),
      });
      if (target) {
        console.log(`[kyra] ${how} on empty screen -> back to`, target);
        navigate(-1);
      } else {
        console.log(`[kyra] ${how} on empty screen -> no going back from here`);
      }
    };
    const onEmptyPinch = () => goBack("pinch");

    // A click or tap on empty screen does the same. Not a click that ends a swipe (the cart's card).
    let down = null;
    const onDown = (e) => (down = { x: e.clientX, y: e.clientY });
    const onClick = (e) => {
      const swiped = down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 12;
      down = null;
      if (!e.isTrusted || e.button !== 0 || swiped) return; // a pinch's own clicks are handled by the pinch
      if (!(e.target instanceof Element) || e.target.closest(OWN_CLICK)) return;
      goBack("click");
    };

    window.addEventListener(PINCH_EMPTY_EVENT, onEmptyPinch);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("click", onClick);
    return () => {
      window.removeEventListener(PINCH_EMPTY_EVENT, onEmptyPinch);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("click", onClick);
    };
  }, [navigate]);

  return null;
}
