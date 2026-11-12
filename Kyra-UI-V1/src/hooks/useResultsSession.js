import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useKyraSession } from "../context/KyraSessionContext.jsx";
import { LOOK_PATH } from "../lib/shopRoutes.js";
import { phaseOf } from "../state/sessionReducer.js";

/**
 * The analysis screens (Skin Tone, Fit) belong to a visit. No visit: home. Ended, or failed before any
 * looks: the look screen, which says so and then resets the mirror.
 */
export function useResultsSession() {
  const navigate = useNavigate();
  const { state } = useKyraSession();
  const session = state.session;
  const phase = phaseOf(session);
  useEffect(() => {
    if (phase === "none") navigate("/", { replace: true });
    else if (phase === "ended" || phase === "error") navigate(LOOK_PATH, { replace: true });
  }, [phase, navigate]);
  return session;
}
