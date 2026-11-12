import { useEffect, useState } from "react";
import { useKyraSession } from "../context/KyraSessionContext.jsx";

const STYLE = {
  position: "fixed",
  left: 0,
  right: 0,
  bottom: 0,
  zIndex: 10000,
  padding: "10px 16px",
  background: "#7a1f3d",
  color: "#fff",
  font: "14px/1.4 system-ui, sans-serif",
  textAlign: "center",
};

/**
 * A plain bar for staff (outside the kiosk design) when the mirror can't work: no kiosk token, or the
 * backend has been unreachable for a while. Visitors otherwise see the normal screens.
 */
export default function StaffNotice() {
  const { state } = useKyraSession();
  const [longOutage, setLongOutage] = useState(false);
  const down = state.connection === "reconnecting" || state.connection === "connecting";

  useEffect(() => {
    if (!down) {
      setLongOutage(false);
      return undefined;
    }
    const timer = setTimeout(() => setLongOutage(true), 10_000);
    return () => clearTimeout(timer);
  }, [down]);

  let message = "";
  if (state.connection === "unauthorized") {
    message = "This mirror needs its kiosk link: in backend/, run “npm run links” and open the Kiosk UI link.";
  } else if (longOutage) {
    message = "Can’t reach the KYRA backend. Is it running (cd backend && npm start)? Retrying…";
  }
  if (!message) return null;
  return (
    <div role="status" style={STYLE}>
      {message}
    </div>
  );
}
