import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import ShopHeader from "../../components/ShopHeader.jsx";
import Toast from "../../components/Toast.jsx";
import { useKyraSession } from "../../context/KyraSessionContext.jsx";
import { useSessionGuard } from "../../hooks/useSessionGuard.js";
import { useToast } from "../../hooks/useToast.js";
import { RESULTS_PATH } from "../../lib/shopRoutes.js";
import { activeRender } from "../../state/sessionReducer.js";
import "./shop.css";

/**
 * Figma: "Account" — not a profile form. It reuses the existing keep() QR so the visitor can scan
 * for the skin-tone and fit analysis. The QR is created for the look on screen and nothing is stored
 * on this device.
 */
export default function AccountScreen() {
  const navigate = useNavigate();
  const session = useSessionGuard();
  const { keep, end } = useKyraSession();
  const { toast, showToast } = useToast();
  const [tried, setTried] = useState(false);

  const render = activeRender(session);
  const active = session?.active;
  const kept = session?.kept;
  const keptForLook = kept && active && kept.round === active.round && kept.option === active.option ? kept : null;
  const ready = render?.status === "done";

  useEffect(() => {
    if (!ready || keptForLook || tried) return;
    setTried(true);
    keep();
  }, [ready, keptForLook, tried, keep]);

  const finish = async () => {
    await end();
    navigate("/", { replace: true });
  };

  if (!session) return <div className="screen" />;

  return (
    <div className="screen">
      <ShopHeader />
      <main className="screen__content shop">
        <h1 className="title title--h4">Account</h1>
        <p className="shop__lede">Scan the QR code to get more info about your skin tone and fit analysis.</p>

        {keptForLook ? (
          <div className="account__qr-card">
            <img className="account__qr" src={keptForLook.qrDataUrl} alt="QR code for this look" />
            <p className="account__qr-caption">
              Scan to open your look, colour palette and fit guidance. This code is temporary.
            </p>
          </div>
        ) : (
          <div className="shop__empty">
            <p>{ready ? "Preparing your QR code…" : "Your look is still being prepared. Please wait a moment."}</p>
            {session.actionError && <p className="account__status">{session.actionError}</p>}
            {ready && !session.actionError && (
              <button type="button" className="shop-button" onClick={() => setTried(false)}>
                Try again
              </button>
            )}
          </div>
        )}

        <div className="shop__actions">
          <button type="button" className="shop-button" onClick={() => navigate(RESULTS_PATH)}>
            Back to your look
          </button>
          <button
            type="button"
            className="shop-button shop-button--ghost"
            onClick={() => {
              showToast("This QR code is only available during your visit", "error");
            }}
          >
            What is this?
          </button>
          <button type="button" className="shop-button shop-button--ghost" onClick={finish}>
            I'm done
          </button>
        </div>
      </main>
      <Toast toast={toast} />
    </div>
  );
}
