import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import EndScreen from "../../components/EndScreen.jsx";
import { useKyraSession } from "../../context/KyraSessionContext.jsx";

const BYE_MS = 4000;

/** Figma "Landing Page" (End, 2043:13349): "Bye / Have a nice day." after any visit ends, then the start. */
export default function ByeScreen() {
  const navigate = useNavigate();
  const { clear } = useKyraSession();
  useEffect(() => {
    const timer = setTimeout(() => {
      clear();
      navigate("/", { replace: true });
    }, BYE_MS);
    return () => clearTimeout(timer);
  }, [clear, navigate]);
  return <EndScreen title="Bye" text="Have a nice day." />;
}
