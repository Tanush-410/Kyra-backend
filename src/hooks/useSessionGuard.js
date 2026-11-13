import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useKyraSession } from "../context/KyraSessionContext.jsx";

/** Shop screens are inside a visit: send the visitor home if the visit ended or was cleared. */
export function useSessionGuard() {
  const navigate = useNavigate();
  const { state } = useKyraSession();
  const session = state.session;

  useEffect(() => {
    if (!session || session.ended) navigate("/", { replace: true });
  }, [session, navigate]);

  return session;
}
