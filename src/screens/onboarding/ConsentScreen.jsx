import { useEffect, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { kyraApi } from "../../api/kyraClient.js";
import AppHeader from "../../components/AppHeader.jsx";
import OptionCard from "../../components/OptionCard.jsx";
import { CAMERA_SOURCE } from "../../config.js";
import { useKyraSession } from "../../context/KyraSessionContext.jsx";
import { intentFromLocation, intentQuery, visitIntent } from "../../lib/visitIntent.js";
import "./ConsentScreen.css";

export const CONSENT = "/welcome/looking-for-today/surpriseme/analysis/consent";
const HOLD_STILL = "/welcome/looking-for-today/surpriseme/analysis/holdstill";
const icon = (name) => `${import.meta.env.BASE_URL}assets/icons/${name}`;

/** The QR code to the privacy page (backend GET /api/v2/privacy); null when phones couldn't open one. */
function usePrivacyQr() {
  const [qr, setQr] = useState(null);
  useEffect(() => {
    let live = true;
    kyraApi
      .privacy()
      .then((answer) => live && answer?.url && setQr(answer))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return qr;
}

/**
 * Figma: Analysis / "Concnt" (2043:13252). Asks before any photo is taken. The visitor's photo goes to
 * OpenAI to design their looks, so the backend refuses to start a visit without consent
 * (REQUIRE_CONSENT, on by default).
 *
 * With the backend camera, Continue starts the visit: the camera then captures when the visitor holds
 * still. With the browser camera, the visit starts once the photo is taken (on the next screen).
 * The QR code opens the privacy page (PRIVACY_URL, or the backend's /privacy); without one it is left out.
 */
export function ConsentView({ qr, busy = false, error = "", onContinue }) {
  return (
    <div className="screen">
      <AppHeader />
      <div className="consent">
        <h1 className="title consent__title">By continuing</h1>
        <div className="consent__row">
          <img className="consent__camera" src={icon("consent-camera.svg")} alt="" width="175.5" height="175.5" />
          <p className="consent__text">
            By continuing, you consent to Kyra capturing an image of you to analyze your skin tone and fit and provide
            personalized recommendations.
          </p>
        </div>
        <p className="consent__note">
          <img src={icon("asterisk.svg")} alt="" width="23" height="23" />
          <span>Kyra needs to capture your image to analyze your skin tone and fit.</span>
        </p>
        <div className="consent__continue">
          <OptionCard label={busy ? "One moment…" : error ? "Try again" : "Continue"} width="w840" onClick={onContinue} />
        </div>
        {error && (
          <p className="consent__error" role="alert">
            {error}
          </p>
        )}
        {qr && (
          <div className="consent__qr">
            <img src={qr.qrDataUrl} alt="QR code: how the mirror uses your information" width="300" height="300" />
            <p className="screen__text">Scan to know more about how your information is used</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function ConsentScreen() {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const { start } = useKyraSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const qr = usePrivacyQr();
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

  return <ConsentView qr={qr} busy={busy} error={error} onContinue={agree} />;
}
