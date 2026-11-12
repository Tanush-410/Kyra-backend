import { useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import AppHeader from "../../components/AppHeader.jsx";
import OptionCard from "../../components/OptionCard.jsx";
import { CAMERA_SOURCE } from "../../config.js";
import { useKyraSession } from "../../context/KyraSessionContext.jsx";
import { intentFromLocation, intentQuery, visitIntent } from "../../lib/visitIntent.js";
import "./ConsentScreen.css";

export const CONSENT = "/welcome/looking-for-today/surpriseme/analysis/consent";
const HOLD_STILL = "/welcome/looking-for-today/surpriseme/analysis/holdstill";

/**
 * Asks before any photo is taken. The visitor's photo goes to OpenAI to design their looks, so the
 * backend refuses to start a visit without consent (REQUIRE_CONSENT, on by default).
 *
 * With the backend camera, agreeing starts the visit: the camera then captures when the visitor holds
 * still. With the browser camera, the visit starts once the photo is taken (on the next screen).
 */
export default function ConsentScreen() {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const { start } = useKyraSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const raw = intentFromLocation(location, params);

  const agree = async () => {
    if (busy) return;
    setError("");
    const next = `${HOLD_STILL}${intentQuery(raw)}`;
    if (CAMERA_SOURCE === "browser") {
      navigate(next, { state: { id: raw.category, text: raw.q, consented: true } });
      return;
    }
    setBusy(true);
    try {
      await start(visitIntent(raw));
      navigate(next, { state: { id: raw.category, text: raw.q } });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen">
      <AppHeader />
      <div className="screen__content consent">
        <h1 className="title">Before we begin</h1>
        <p className="screen__text consent__text">
          To match colours and fit to you, I’ll take a photo when you hold still. It’s sent to OpenAI, our AI
          partner, to create your looks.
        </p>
        <p className="screen__text consent__text consent__text--quiet">
          The mirror doesn’t save it: it’s forgotten when you leave, unless you choose to take a look home.
        </p>
        {error && (
          <p className="consent__error" role="alert">
            {error}
          </p>
        )}
        <div className="button-row">
          <OptionCard label={busy ? "One moment…" : error ? "Try again" : "I agree"} width="w500" onClick={agree} />
          <OptionCard label="No thanks" width="w500" onClick={() => navigate("/")} />
        </div>
      </div>
    </div>
  );
}
