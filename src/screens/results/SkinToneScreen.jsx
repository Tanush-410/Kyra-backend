import { useState } from "react";
import { useNavigate } from "react-router-dom";
import AppHeader from "../../components/AppHeader.jsx";
import CameraFeed from "../../components/CameraFeed.jsx";
import Dialog from "../../components/Dialog.jsx";
import KyraLoader from "../../components/KyraLoader.jsx";
import LookShortcut from "../../components/LookShortcut.jsx";
import OptionCard from "../../components/OptionCard.jsx";
import { useKyraSession } from "../../context/KyraSessionContext.jsx";
import { useProductPhotos } from "../../hooks/useProductPhotos.js";
import { useResultsSession } from "../../hooks/useResultsSession.js";
import { allOutfits } from "../../lib/outfits.js";
import { colourChips, paletteRoles } from "../../lib/colourRoles.js";
import { FIT_PATH, LOOK_PATH } from "../../lib/shopRoutes.js";
import { undertoneView } from "../../state/sessionReducer.js";
import "./SkinToneScreen.css";

const UNDERTONES = ["warm", "neutral", "cool"];
const capitalise = (text) => (text ? text[0].toUpperCase() + text.slice(1) : "");

// One friendly line per undertone (the detector's own sentence is technical).
const UNDERTONE_LINES = {
  warm: "Golden, earthy shades bring out your glow.",
  cool: "Jewel tones and crisp, cool shades flatter you most.",
  neutral: "Lucky you: both warm and cool shades suit you.",
};

/**
 * Figma: "Colour Result" / Skin Tone Analysis (2043:13274; the card as exported in design/export-1,
 * Component 80). view: undertoneView(session), or null while the profile is still being worked out
 * (the "Analysing" frame 2043:13245 is shown then).
 */
export function SkinToneView({ view, depth, shortcut, onKnowMore, onKnowFit, background = null }) {
  if (!view) {
    return (
      <div className="screen">
        {background}
        {background && <div className="results-backdrop" />}
        <AppHeader />
        <div className="screen__content screen__content--analysing skin__analysing">
          <h1 className="title">Building your profile.</h1>
          <p className="screen__text">We’re analysing your skin tone and fit to personalise your recommendations.</p>
        </div>
        <KyraLoader label="Analysing" />
        <div className="skin__shortcut">{shortcut}</div>
      </div>
    );
  }
  const roles = paletteRoles(view.palette);
  const chips = colourChips({ undertone: view.undertone, olive: view.olive, depth, skinHex: view.skinHex, palette: view.palette });
  return (
    <div className="screen">
      {background}
      {background && <div className="results-backdrop" />}
      <AppHeader />
      <div className="skin">
        <h1 className="title title--h4 skin__title">Skin Tone Analysis</h1>
        <section className="skin__card" aria-label="Your colours">
          <p className="skin__eyebrow">Your Colors</p>
          <h2 className="skin__heading">Colors that complement you</h2>
          <ul className="skin__chips">
            {chips.map((chip) => (
              <li key={chip.key} className="skin__chip">
                <i style={{ background: chip.dot }} />
                {chip.label}
              </li>
            ))}
          </ul>
          <hr className="skin__rule skin__rule--top" />
          <ul className="skin__names">
            {roles.map((colour) => (
              <li key={colour.hex} className="skin__name">
                {colour.name}
              </li>
            ))}
          </ul>
          <ul className="skin__roles" aria-hidden="true">
            {roles.map((colour) => (
              <li key={colour.hex}>
                <span className="skin__role">{colour.role}</span>
              </li>
            ))}
          </ul>
          <div className="skin__fan" aria-hidden="true">
            {roles.map((colour, i) => (
              <span key={colour.hex} style={{ background: colour.hex, left: `${i * 129.25}px`, zIndex: roles.length - i }} />
            ))}
          </div>
          <hr className="skin__rule skin__rule--bottom" />
          <button type="button" className="outline-button skin__more" onClick={onKnowMore}>
            Know more
          </button>
        </section>
        <div className="skin__fit">
          <OptionCard label="Know my fit" width="w840" onClick={onKnowFit} />
        </div>
        <div className="skin__shortcut">{shortcut}</div>
      </div>
    </div>
  );
}

/** The undertone question: "Does this sound like you?" (unsure readings), or a correction from Know more. */
function UndertoneDialog({ view, asking, onConfirm, onCorrect, onClose }) {
  const others = UNDERTONES.filter((u) => u !== view.undertone);
  return (
    <Dialog
      title={asking ? "Does this sound like you?" : "Your undertone"}
      actions={[
        ...(asking ? [{ label: `Yes, I’m ${view.undertone}`, onClick: onConfirm }] : []),
        ...others.map((u) => ({ label: `I’m ${u}`, onClick: () => onCorrect(u) })),
        ...(asking ? [] : [{ label: "Close", onClick: onClose }]),
      ]}
    >
      <p>
        {asking
          ? `I read your undertone as ${view.undertone}, but I’m not completely sure.`
          : `I read your undertone as ${view.undertone}. If that isn’t right, tell me and I’ll redo your colours and looks.`}
      </p>
    </Dialog>
  );
}

export default function SkinToneScreen() {
  const navigate = useNavigate();
  const session = useResultsSession();
  const { confirmProfile, correctUndertone } = useKyraSession();
  const [dialog, setDialog] = useState(null); // "more" | "correct" | null
  const [answered, setAnswered] = useState(false);
  // Start the first outfit's product photos now (about 10 s each, two at a time), so they're ready by
  // Suggestions. Only the first outfit: nothing is made for outfits the visitor may never open.
  useProductPhotos(allOutfits(session)[0] || null);
  if (!session) return null;

  const view = undertoneView(session);
  const asking = Boolean(view?.needsConfirmation && !answered);
  const open = dialog || (asking ? "ask" : null);
  const shortcut = <LookShortcut session={session} onOpen={() => navigate(LOOK_PATH)} />;

  return (
    <div className="skin-screen">
      <div inert={open ? "" : undefined}>
        <SkinToneView
          view={view}
          depth={session.profile?.skinDepth || session.skin?.skinDepth || null}
          shortcut={shortcut}
          background={<CameraFeed />}
          onKnowMore={() => setDialog("more")}
          onKnowFit={() => navigate(FIT_PATH)}
        />
      </div>
      {open === "more" && (
        <Dialog
          title={view.sure ? `${capitalise(view.undertone)} undertone${view.olive ? " (olive)" : ""}` : "Your colours"}
          actions={[
            { label: "Close", onClick: () => setDialog(null) },
            { label: "My undertone is different", onClick: () => setDialog("correct") },
          ]}
        >
          <p>
            {view.sure
              ? UNDERTONE_LINES[view.undertone] || view.statement
              : "I couldn’t read your undertone clearly, so I picked colours that suit everyone."}
            {view.sure && view.metals.length > 0 ? ` Best metals: ${view.metals.join(", ")}.` : ""}
          </p>
        </Dialog>
      )}
      {(open === "ask" || open === "correct") && (
        <UndertoneDialog
          view={view}
          asking={open === "ask"}
          onConfirm={() => {
            setAnswered(true);
            confirmProfile();
          }}
          onCorrect={(u) => {
            setAnswered(true);
            setDialog(null);
            correctUndertone(u);
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
