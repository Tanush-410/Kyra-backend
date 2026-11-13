import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { kyraApi } from "../../api/kyraClient.js";
import KyraLoader from "../../components/KyraLoader.jsx";
import AppHeader from "../../components/AppHeader.jsx";
import { useCartTool } from "../../hooks/useCartTool.js";
import { useKyraSession } from "../../context/KyraSessionContext.jsx";
import { phaseOf } from "../../state/sessionReducer.js";
import "./AccountScreen.css";

/**
 * Figma: "Account" (2043:18468): "Scan the QR code to get more info". The QR opens a temporary page of
 * this visit's results (POST /api/v2/sessions/:id/results): undertone, colours, fit notes, and a look
 * only if the visitor took it home. Same private link and expiry as a kept look (KEEP_HOURS).
 *
 * view: { kind: "ready", qr } | { kind: "loading" } | { kind: "message", text }
 */
export function AccountView({ view, onBack, header }) {
  return (
    <div className="screen account">
      {header}
      <h1 className="title title--h4 account__title">Scan the QR code to get more info</h1>
      {view.kind === "ready" && (
        <>
          <img className="account__qr" src={view.qr.qrDataUrl} alt="QR code: your results" width="524" height="524" />
          <p className="account__caption">Get more information on your skin tone and fit analysis by scanning the above QR code.</p>
          {view.qr.expiresAt && (
            <p className="account__expiry">
              The page is deleted on {new Date(view.qr.expiresAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}.
            </p>
          )}
        </>
      )}
      {view.kind === "loading" && <KyraLoader label="Preparing your results" />}
      {view.kind === "message" && <p className="account__caption account__caption--message">{view.text}</p>}
      <button type="button" className="outline-button account__back" onClick={onBack}>
        Back
      </button>
    </div>
  );
}

export default function AccountScreen() {
  const navigate = useNavigate();
  const { state } = useKyraSession();
  const session = state.session;
  const phase = phaseOf(session);
  const ready = phase === "results" && Boolean(session?.profile);
  const [qr, setQr] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!ready || qr) return undefined;
    let live = true;
    kyraApi
      .results(session.id)
      .then((answer) => live && setQr(answer))
      .catch((err) => live && setError(err.message));
    return () => {
      live = false;
    };
    // a new page when a look is taken home (session.kept changes)
  }, [ready, session?.id, session?.kept?.url]); // eslint-disable-line react-hooks/exhaustive-deps

  const cart = useCartTool();
  const afterPhoto = phase === "results"; // the cart, from the photo onwards
  let view;
  if (!session || phase === "none" || phase === "ended") view = { kind: "message", text: "Your skin tone and fit results appear here once Kyra has taken your photo." };
  else if (!ready) view = { kind: "message", text: "Kyra is still working out your results. Try again in a moment." };
  else if (error) view = { kind: "message", text: error };
  else if (qr) view = { kind: "ready", qr };
  else view = { kind: "loading" };

  return <AccountView view={view} onBack={() => navigate(-1)} header={<AppHeader onProfileClick={() => {}} {...(afterPhoto ? cart : {})} />} />;
}
