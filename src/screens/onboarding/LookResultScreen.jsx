import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import AppHeader from "../../components/AppHeader.jsx";
import OptionCard from "../../components/OptionCard.jsx";
import { useKyraSession } from "../../context/KyraSessionContext.jsx";
import { activeOption, activeRender, keyOf, phaseOf, undertoneView } from "../../state/sessionReducer.js";
import "./LookResultScreen.css";

const HOME = "/";
const ENDED_MS = 5000; // how long "Thanks for visiting" stays before the mirror resets

const ENDED_COPY = {
  visitor_left: "Looks like you’ve stepped away. Come back any time!",
  timeout: "This visit has timed out. Wave to start again!",
  replaced: "Someone new stepped in. Wave to start your own visit!",
};

const capitalise = (text) => (text ? text[0].toUpperCase() + text.slice(1) : "");

// One friendly line per undertone (the detector's own sentence is technical).
const UNDERTONE_LINES = {
  warm: "Golden, earthy shades bring out your glow.",
  cool: "Jewel tones and crisp, cool shades flatter you most.",
  neutral: "Lucky you: both warm and cool shades suit you.",
};

function Swatch({ hex, label, large = false }) {
  return (
    <span className={`look__swatch${large ? " look__swatch--large" : ""}`}>
      <i style={{ background: hex }} />
      {label && <span>{label}</span>}
    </span>
  );
}

function ColoursCard({ view, onConfirm, onCorrect, confirmed }) {
  if (!view) {
    return (
      <section className="look__card">
        <h2 className="look__heading">Reading your colours…</h2>
      </section>
    );
  }
  return (
    <section className="look__card">
      <div className="look__row">
        {view.skinHex && <Swatch hex={view.skinHex} large />}
        <h2 className="look__heading">
          {view.sure ? (
            <>
              {capitalise(view.undertone)} undertone{view.olive ? " (olive)" : ""}
            </>
          ) : (
            "Your colours"
          )}
        </h2>
      </div>
      <p className="look__text">
        {view.sure
          ? UNDERTONE_LINES[view.undertone] || view.statement
          : "I couldn’t read your undertone clearly, so I picked colours that suit everyone."}
      </p>
      {view.palette.length > 0 && (
        <div className="look__palette">
          {view.palette.slice(0, 6).map((colour) => (
            <Swatch key={colour.hex} hex={colour.hex} label={colour.name} />
          ))}
        </div>
      )}
      {view.sure && view.metals.length > 0 && <p className="look__text look__text--quiet">Best metals: {view.metals.join(", ")}</p>}
      {view.needsConfirmation && !confirmed && (
        <div className="look__confirm">
          <p className="look__text">Does this sound like you?</p>
          <div className="look__chips">
            <button type="button" className="look__chip look__chip--yes" onClick={onConfirm}>
              Yes
            </button>
            {["warm", "neutral", "cool"]
              .filter((u) => u !== view.undertone)
              .map((u) => (
                <button key={u} type="button" className="look__chip" onClick={() => onCorrect(u)}>
                  I’m {u}
                </button>
              ))}
          </div>
        </div>
      )}
    </section>
  );
}

function LookImage({ render, option, status, degraded }) {
  if (render?.status === "done" && render.imageDataUrl) {
    return <img className="look__image" src={render.imageDataUrl} alt={option ? `You in ${option.title}` : "Your look"} />;
  }
  let caption = "Designing your looks…";
  if (degraded) caption = degraded.message || "Pictures are unavailable right now, so here are your looks in words.";
  else if (render?.status === "failed") caption = render.error || "I couldn’t create this picture. Try another look.";
  else if (render?.status === "queued") caption = "Your look is next in line…";
  else if (render?.status === "rendering" || option) caption = "Creating your look…";
  else if (status === "analyzing") caption = "Analysing your photo…";
  return (
    <div className={`look__image look__image--pending${render?.preview ? " has-preview" : ""}`}>
      {render?.preview && <img src={render.preview} alt="" />}
      <p>{caption}</p>
      {!degraded && render?.status !== "failed" && <span className="look__spinner" aria-hidden="true" />}
    </div>
  );
}

/**
 * The visitor's results: their measured colours, the look rendered on them, and what they can do next
 * (love it, see another, take it home by QR code, finish). Everything here comes from the backend's
 * event stream for this visit (KyraSessionContext); pictures stay in memory only.
 */
export default function LookResultScreen() {
  const navigate = useNavigate();
  const { state, like, showAnother, keep, confirmProfile, correctUndertone, end, clear } = useKyraSession();
  const session = state.session;
  const phase = phaseOf(session);
  const [closedQr, setClosedQr] = useState(null);

  useEffect(() => {
    if (phase !== "ended") return undefined;
    const timer = setTimeout(() => {
      clear();
      navigate(HOME, { replace: true });
    }, ENDED_MS);
    return () => clearTimeout(timer);
  }, [phase, clear, navigate]);

  useEffect(() => {
    if (phase === "none") navigate(HOME, { replace: true });
  }, [phase, navigate]);

  if (!session) return null;

  if (phase === "ended" || phase === "error") {
    return (
      <div className="screen">
        <AppHeader />
        <div className="screen__content look look--centred">
          <h1 className="title">{phase === "ended" ? "Thanks for visiting!" : "Something went wrong"}</h1>
          <p className="screen__text">{phase === "ended" ? ENDED_COPY[session.ended] || "See you next time!" : session.error}</p>
          <OptionCard
            label="Start again"
            width="w500"
            onClick={async () => {
              await end();
              navigate(HOME, { replace: true });
            }}
          />
        </div>
      </div>
    );
  }

  const option = activeOption(session);
  const render = activeRender(session);
  const view = undertoneView(session);
  const done = render?.status === "done";
  const busy = render?.status === "rendering" || render?.status === "queued";
  const activeKey = session.active ? keyOf(session.active.round, session.active.option) : null;
  const liked = activeKey && session.ratings[activeKey] === "up";
  const optionCount = session.rounds[session.active?.round ?? session.currentRound]?.length || 0;
  const kept = session.kept && keyOf(session.kept.round, session.kept.option) === activeKey ? session.kept : null;

  const qrOpen = Boolean(kept?.qrDataUrl && closedQr !== kept.url);

  const finish = async () => {
    await end();
    navigate(HOME, { replace: true });
  };

  return (
    <div className="screen">
      <AppHeader />
      <div className="screen__content look" inert={qrOpen ? "" : undefined}>
        <h1 className="title title--h4">{done ? "Here’s your look" : option ? "Your look is on its way" : "Building your profile"}</h1>

        <LookImage render={render} option={option} status={session.status} degraded={session.degraded} />

        {session.actionError && (
          <p className="look__error" role="alert">
            {session.actionError}
          </p>
        )}

        <div className="look__actions">
          <OptionCard label={liked ? "Loved it ♥" : "Love it"} width="w500" onClick={like} disabled={!done || liked} />
          {/* Each new look is a new picture (it costs), so one at a time. */}
          <OptionCard label="Show another" width="w500" onClick={showAnother} disabled={!option || busy} />
          <OptionCard label="Take it home" width="w500" onClick={keep} disabled={!done} />
          <OptionCard label="I’m done" width="w500" onClick={finish} />
        </div>

        {option && (
          <section className="look__card">
            {optionCount > 1 && (
              <p className="look__count">
                Look {option.option} of {optionCount}
              </p>
            )}
            <h2 className="look__heading">{option.title}</h2>
            <p className="look__text">{option.summary}</p>
            <ul className="look__items">
              {option.items.map((item) => (
                <li key={`${item.category}-${item.name}`}>
                  <Swatch hex={item.hex} />
                  <span>
                    {item.name}
                    {item.colorName && <span className="look__text--quiet"> · {item.colorName}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <ColoursCard view={view} confirmed={session.profileConfirmed} onConfirm={confirmProfile} onCorrect={correctUndertone} />

      </div>

      {qrOpen && (
        <div className="look__qr" role="dialog" aria-modal="true" aria-label="Take your look home">
          <div className="look__qr-card">
            <h2 className="look__heading">Scan to take your look home</h2>
            <img src={kept.qrDataUrl} alt="QR code for your look" />
            {kept.expiresAt && (
              <p className="look__text look__text--quiet">
                The link works until {new Date(kept.expiresAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}.
              </p>
            )}
            <div className="button-stack">
              <OptionCard label="Keep browsing" onClick={() => setClosedQr(kept.url)} />
              <OptionCard label="I’m done" onClick={finish} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
