import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useKyraSession } from "../context/KyraSessionContext.jsx";
import { BYE_PATH, LOOK_PATH } from "../lib/shopRoutes.js";
import { phaseOf } from "../state/sessionReducer.js";

/**
 * The results screens belong to a visit. No visit: home. Ended: "Bye". Failed before any looks: the look
 * screen, which says so.
 */
export function useResultsSession() {
  const navigate = useNavigate();
  const { state } = useKyraSession();
  const session = state.session;
  const phase = phaseOf(session);
  useEffect(() => {
    if (phase === "none") navigate("/", { replace: true });
    else if (phase === "ended") navigate(BYE_PATH, { replace: true });
    else if (phase === "error") navigate(LOOK_PATH, { replace: true });
  }, [phase, navigate]);
  return session;
}
