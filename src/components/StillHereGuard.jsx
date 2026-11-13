import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { kyraApi } from "../api/kyraClient.js";
import { useKyraSession } from "../context/KyraSessionContext.jsx";
import { BYE_PATH } from "../lib/shopRoutes.js";
import { stillHereState, stillHereText } from "../lib/stillHere.js";
import { phaseOf } from "../state/sessionReducer.js";
import EndScreen from "./EndScreen.jsx";

// If the backend's countdown ran out but no session.ended arrived (a dropped stream), end it here.
const AWAY_SLACK_MS = 5000;

/**
 * "Still here?" over whatever screen a visit is on (Figma "Confirmation" 2043:13383), with the
 * countdown: when the camera lost the visitor (the backend ends the visit at endsAt unless they come
 * back or press Still here), or after 90 s without a tap, pinch or gesture (this kiosk ends it).
 * Everything underneath is inert meanwhile, so a pinch can't press it.
 */
export default function StillHereGuard({ children }) {
  const navigate = useNavigate();
  const { state, dispatchStayed } = useKyraSession();
  const session = state.session;
  const phase = phaseOf(session);
  const [lastInteraction, setLastInteraction] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const ending = useRef(false);

  const touch = useCallback(() => setLastInteraction(Date.now()), []);

  // Taps and pinches (a pinch clicks: HandTrackingContext), keys; and the camera's hand gestures.
  useEffect(() => {
    const options = { capture: true, passive: true };
    window.addEventListener("pointerdown", touch, options);
    window.addEventListener("click", touch, options);
    window.addEventListener("keydown", touch, options);
    return () => {
      window.removeEventListener("pointerdown", touch, options);
      window.removeEventListener("click", touch, options);
      window.removeEventListener("keydown", touch, options);
    };
  }, [touch]);
  useEffect(() => {
    if (state.lastGestureAt) touch();
  }, [state.lastGestureAt, touch]);
  // A new visit, or the photo just taken: the clock starts now.
  useEffect(() => {
    touch();
    ending.current = false;
  }, [session?.id, phase === "results", touch]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = phase === "results";
  useEffect(() => {
    if (!open) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [open]);

  const view = stillHereState({ session, phase, lastInteraction, now });

  // Bye ends the visit when it opens (ending it here first would let the screen underneath go home).
  const deleteSession = useCallback(() => {
    if (ending.current) return;
    ending.current = true;
    navigate(BYE_PATH, { replace: true });
  }, [navigate]);

  useEffect(() => {
    if (!view) return;
    const overdue = view.reason === "idle" ? now >= view.endsAt : now >= view.endsAt + AWAY_SLACK_MS;
    if (overdue) deleteSession();
  }, [view, now, deleteSession]);

  const stay = async () => {
    touch();
    if (view?.reason === "away" && session) {
      dispatchStayed();
      await kyraApi.stillHere(session.id).catch(() => {});
    }
  };

  return (
    <>
      <div inert={view ? "" : undefined}>{children}</div>
      {view && (
        <div className="still-here" role="dialog" aria-modal="true" aria-label="Still here?">
          <EndScreen
            live
            title="Still here?"
            text={stillHereText(view.secondsLeft)}
            // The camera can't see them: pressing Still here alone just starts the countdown again.
            note={view.reason === "away" ? "I can’t see you. Step in front of the mirror to stay." : null}
            actions={[
              { label: "Still Here", onClick: stay },
              { label: "Delete Session", onClick: deleteSession },
            ]}
          />
        </div>
      )}
    </>
  );
}
