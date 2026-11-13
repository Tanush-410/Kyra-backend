import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import AppHeader from "../../components/AppHeader.jsx";
import { useCartTool } from "../../hooks/useCartTool.js";
import KyraLoader from "../../components/KyraLoader.jsx";
import OptionCard from "../../components/OptionCard.jsx";
import Toast from "../../components/Toast.jsx";
import { useKyraSession } from "../../context/KyraSessionContext.jsx";
import { useMicLevel } from "../../hooks/useMicLevel.js";
import { useResultsSession } from "../../hooks/useResultsSession.js";
import { useSpeechToText } from "../../hooks/useSpeechToText.js";
import { useToast } from "../../hooks/useToast.js";
import { editFeedback, editPieces, INTENTS } from "../../lib/editFeedback.js";
import { SUGGESTIONS_PATH } from "../../lib/shopRoutes.js";
import { activeOption, isDesigning } from "../../state/sessionReducer.js";
import "../onboarding/ListeningScreen.css";
import "./EditLookScreen.css";

const asset = (path) => `${import.meta.env.BASE_URL}${path}`;
// For visitors who'd rather not speak, or a browser without speech recognition.
const PRESETS = ["More casual", "More colourful", "More formal", "Simpler"];
const VOICE_MESSAGES = {
  unsupported: "Voice isn’t available here. Pick one of these instead.",
  "no-speech": "I didn’t catch that. Try again, or pick one of these.",
  "not-allowed": "The microphone isn’t allowed. Pick one of these instead.",
  "audio-capture": "No microphone found. Pick one of these instead.",
  network: "Voice needs the internet. Pick one of these instead.",
  other: "Voice stopped. Try again, or pick one of these.",
};

/** Listening (Figma "Catagories" 2043:13036 / Edit 17888): Kyra's rings move with the voice. */
function Listening({ onDone, onPreset }) {
  const kyraRef = useRef(null);
  const { finalText, interim, status, error } = useSpeechToText({ onDone, noSpeechMs: 8000 });
  const listening = status === "starting" || status === "listening";
  useMicLevel(kyraRef, { active: listening });
  const message = status === "unsupported" ? VOICE_MESSAGES.unsupported : error && VOICE_MESSAGES[error];
  return (
    <>
      <div className="screen__content">
        <h1 className="title title--h4">Listening</h1>
      </div>
      <div ref={kyraRef} className={`listening__kyra${listening ? "" : " is-idle"}`}>
        <span className="listening__idle">
          <span className="listening__ring listening__ring--breathe" />
        </span>
        <span className="listening__ring listening__ring--1" />
        <span className="listening__ring listening__ring--2" />
        <span className="listening__ring listening__ring--3" />
        <span className="listening__glow" />
        <img src={asset("assets/brand/kyra-talking.png")} alt="" />
      </div>
      <div className="listening__transcript" aria-live="polite">
        <p className="listening__text">
          {finalText}
          {interim && <span className="listening__interim"> {interim}</span>}
        </p>
        {message && <p className="listening__hint">{message}</p>}
      </div>
      {message && <Presets onPick={onPreset} />}
    </>
  );
}

function Presets({ onPick, disabled = false }) {
  return (
    <div className="edit__presets">
      {PRESETS.map((label) => (
        <button key={label} type="button" className="edit__preset" onClick={() => onPick(label)} disabled={disabled}>
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * Figma: "Edit" (2043:13659). step: "piece" (What would you like to edit?) -> "intent" (What's on your
 * mind?) -> "voice" -> "listening" (for Suggest changes / I know what I want) -> "working" (Let's find
 * what you're looking for). busy: a round is already being designed, so choices wait.
 */
export function EditView({ step, gender, outfit, busy, onPiece, onIntent, onListen, onWords, onBack }) {
  const pieces = editPieces(gender);
  const cart = useCartTool();
  return (
    <div className="screen edit">
      <AppHeader {...cart} />
      {step === "working" && (
        <>
          <div className="screen__content">
            <h1 className="title">Let’s find what you’re looking for</h1>
          </div>
          <KyraLoader label="Designing new looks" />
        </>
      )}
      {step === "piece" && (
        <div className="screen__content edit__content">
          <h1 className="title">What would you like to edit?</h1>
          <p className="edit__outfit">{outfit}</p>
          <div className="option-grid">
            {pieces.map((p, i) => (
              <div key={p.key} className={i === pieces.length - 1 && pieces.length % 2 ? "option-grid__span" : undefined}>
                <OptionCard label={p.label} icon={asset(p.icon)} iconWidth={p.iconWidth} width="w500" onClick={() => onPiece(p.key)} disabled={busy} />
              </div>
            ))}
          </div>
        </div>
      )}
      {step === "intent" && (
        <div className="screen__content edit__content">
          <h1 className="title">What’s on your mind?</h1>
          <div className="button-stack">
            {INTENTS.map((intent) => (
              <OptionCard key={intent.key} label={intent.label} onClick={() => onIntent(intent)} disabled={busy} />
            ))}
          </div>
        </div>
      )}
      {step === "voice" && (
        <div className="screen__content edit__content">
          <h1 className="title">Tell us what you have in mind</h1>
          <OptionCard label="Voice search" icon={asset("assets/icons/voicesearch.png")} width="w500" onClick={onListen} disabled={busy} />
          <Presets onPick={onWords} disabled={busy} />
        </div>
      )}
      {step === "listening" && <Listening onDone={onWords} onPreset={onWords} />}
      {busy && step !== "working" && <p className="edit__busy">Kyra is still designing your last request…</p>}
      {step !== "working" && (
        <button type="button" className="outline-button edit__back" onClick={onBack}>
          Back
        </button>
      )}
    </div>
  );
}

export default function EditLookScreen() {
  const navigate = useNavigate();
  const location = useLocation();
  const session = useResultsSession();
  const { state, redesigning, redesign } = useKyraSession();
  const { toast, showToast } = useToast();
  // A product card can open this for one piece (state.piece), and "Find something different" goes
  // straight to the redesign (state.intent "different").
  const startPiece = location.state?.piece || null;
  const [step, setStep] = useState(startPiece ? "intent" : "piece");
  const [piece, setPiece] = useState(startPiece);
  const [intent, setIntent] = useState(null);
  const auto = useRef(false);
  useEffect(() => {
    if (auto.current || !session || !startPiece || location.state?.intent !== "different") return;
    auto.current = true;
    submit("different"); // eslint-disable-line no-use-before-define
  }); // eslint-disable-line react-hooks/exhaustive-deps
  if (!session) return null;

  // The outfit being edited: the one Suggestions opened this for, else the look on screen.
  const target = location.state?.round ? session.rounds[location.state.round]?.find((o) => o.option === location.state.option) : null;
  const option = target || activeOption(session);
  const busy = isDesigning(state.session, redesigning);

  // One redesign: a new round of three, its first look rendered. The context drops a second one.
  const submit = async (intentKey, words = "") => {
    if (!option || busy) return;
    setStep("working");
    const answer = await redesign(editFeedback({ option, piece, intent: intentKey, words }));
    if (answer) {
      navigate(SUGGESTIONS_PATH, { replace: true, state: { edited: true } });
      return;
    }
    setStep("intent");
    showToast("Please try again", "error");
  };
  const back = () => {
    if (step === "piece") navigate(SUGGESTIONS_PATH);
    else if (step === "intent") setStep("piece");
    else setStep("intent");
  };

  return (
    <div className="edit-wrap">
      <EditView
        step={step}
        gender={session.gender}
        outfit={option ? `Editing “${option.title}”` : ""}
        busy={busy && step !== "working"}
        onPiece={(key) => {
          setPiece(key);
          setStep("intent");
        }}
        onIntent={(chosen) => {
          setIntent(chosen);
          if (chosen.words) setStep("voice");
          else submit(chosen.key);
        }}
        onListen={() => setStep("listening")}
        onWords={(words) => submit(intent.key, words)}
        onBack={back}
      />
      <Toast toast={toast} />
    </div>
  );
}
