import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import AppHeader from "../../components/AppHeader.jsx";
import CameraFeed from "../../components/CameraFeed.jsx";
import LookShortcut from "../../components/LookShortcut.jsx";
import { useResultsSession } from "../../hooks/useResultsSession.js";
import { defaultGoal, fitNotes, GOALS, leversFor } from "../../lib/fitLevers.js";
import { LOOK_PATH } from "../../lib/shopRoutes.js";
import "./FitAnalysisScreen.css";

const asset = (path) => `${import.meta.env.BASE_URL}assets/${path}`;
const GUIDE_MS = 4000;
const guidedSessions = new Set(); // the guide shows once per visit

const DEFAULT_NOTE = {
  title: "Your fit, mapped out.",
  text: "Your scan is complete. Explore the outlines on your silhouette to discover how your body proportions work together and what they mean for your fit.",
};

// The outlines on the silhouette, in px within the 278 x 992 silhouette box, which sits at (87, 744)
// on the screen (measured from design/export-1, "Fit analysis").
const LINES = [
  { key: "shoulders", y: 189, x1: 42, x2: 236 },
  { key: "bust", y: 281, x1: 63, x2: 214 },
  { key: "waist", y: 364, x1: 94, x2: 183 },
  { key: "hips", y: 424, x1: 62, x2: 216 },
];
const CENTRE_X = 139;

/** Lines only, for visitors the design has no silhouette for (it is a woman's figure). */
function Outline() {
  return (
    <svg className="fit__outline" viewBox="0 0 278 992" width="278" height="992" aria-hidden="true">
      <line x1={CENTRE_X} y1="6" x2={CENTRE_X} y2="978" stroke="#c8bab2" strokeWidth="2" strokeDasharray="6 6" />
      {[6, 78, 978].map((y) => (
        <circle key={y} cx={CENTRE_X} cy={y} r="4" fill="#fff" />
      ))}
      {LINES.map((l) => (
        <g key={l.key}>
          <line x1={l.x1} y1={l.y} x2={l.x2} y2={l.y} stroke="#d9cfc9" strokeWidth="3" />
          <circle cx={l.x1} cy={l.y} r="4" fill="#fff" />
          <circle cx={l.x2} cy={l.y} r="4" fill="#fff" />
        </g>
      ))}
    </svg>
  );
}

/** Calls onHover while the hand pointer (data-hand-hovered, HandTrackingContext) or a mouse is over el. */
function useHover(ref, onHover) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const observer = new MutationObserver(() => {
      if (el.getAttribute("data-hand-hovered") === "true") onHover();
    });
    observer.observe(el, { attributes: true, attributeFilter: ["data-hand-hovered"] });
    return () => observer.disconnect();
  }, [ref, onHover]);
}

function Hotspot({ note, style, onShow, label }) {
  const ref = useRef(null);
  useHover(ref, onShow);
  return <button ref={ref} type="button" className="fit__hotspot" style={style} aria-label={label} onMouseEnter={onShow} onFocus={onShow} onClick={onShow} disabled={!note} />;
}

/**
 * Figma: "Fit analysis" and "Guide" (design/export-1). goal: one of GOALS; notes: fitNotes(...);
 * female: show the design's silhouette (otherwise only its outlines); guide: the first-time overlay.
 */
export function FitAnalysisView({ goal, onGoal, notes, female, guide, onGuideDone, shortcut, background = null }) {
  const [active, setActive] = useState(null);
  const note = (active && notes[active]) || DEFAULT_NOTE;
  const levers = leversFor(goal, { female });
  return (
    <div className="screen">
      {background}
      {background && <div className="results-backdrop" />}
      <AppHeader />
      <div className="fit" inert={guide ? "" : undefined}>
        <section className="fit__card">
          <img className="fit__star" src={asset("icons/kyra-star.png")} alt="" width="72" height="72" />
          <h1 className="fit__title">See what loves you back</h1>
          <p className="fit__lede">Here’s how your measurements and proportions work together, and what they mean for your fit.</p>

          <div className="fit__body">
            {female ? <img src={asset("brand/fit-silhouette.png")} alt="" width="278" height="992" /> : <Outline />}
            <Hotspot
              label="Height"
              note={notes.height}
              onShow={() => notes.height && setActive("height")}
              style={{ left: CENTRE_X - 40, top: 0, width: 80, height: 100 }}
            />
            <Hotspot
              label="Shoulders"
              note={notes.shoulders}
              onShow={() => notes.shoulders && setActive("shoulders")}
              style={{ left: LINES[0].x1 - 10, top: LINES[0].y - 30, width: LINES[0].x2 - LINES[0].x1 + 20, height: 60 }}
            />
          </div>

          <article className="fit__note" aria-live="polite">
            <span className="fit__tag">FIT ANALYSIS</span>
            <h2 className="fit__note-title">{note.title}</h2>
            <p className="fit__note-text">{note.text}</p>
          </article>

          <h2 className="fit__levers-title">Styling Levers</h2>
          <ul className="fit__levers">
            {levers.map((lever) => (
              <li key={lever.label}>
                <span className="fit__lever-icon" style={lever.ring ? { borderColor: lever.ring } : undefined} data-ringed={lever.ring ? "false" : "true"}>
                  <img src={asset(`icons/${lever.icon}`)} alt="" />
                </span>
                {lever.label}
              </li>
            ))}
          </ul>

          <div className="fit__goals">
            {GOALS.map((g) => (
              <button key={g.key} type="button" className={`fit__goal${g.key === goal ? " fit__goal--on" : ""}`} aria-pressed={g.key === goal} onClick={() => onGoal(g.key)}>
                {g.label}
              </button>
            ))}
          </div>
        </section>
        <div className="fit__shortcut">{shortcut}</div>
      </div>

      {guide && (
        <button type="button" className="fit__guide" onClick={onGuideDone} aria-label="Hover over the outlines to get more information">
          {female ? <img src={asset("brand/fit-guide.png")} alt="" width="278" height="992" /> : <span className="fit__guide-outline"><Outline /></span>}
          <span className="fit__guide-text">Hover to get more information</span>
        </button>
      )}
    </div>
  );
}

export default function FitAnalysisScreen() {
  const navigate = useNavigate();
  const session = useResultsSession();
  const profile = session?.profile || null;
  const [goal, setGoal] = useState(() => defaultGoal(profile));
  const [guide, setGuide] = useState(() => Boolean(session && !guidedSessions.has(session.id)));

  useEffect(() => {
    if (!guide || !session) return undefined;
    guidedSessions.add(session.id);
    const timer = setTimeout(() => setGuide(false), GUIDE_MS);
    return () => clearTimeout(timer);
  }, [guide, session]);

  if (!session) return null;
  return (
    <FitAnalysisView
      goal={goal}
      onGoal={setGoal}
      notes={fitNotes(profile, session.fitGuidance)}
      female={session.gender === "female"}
      guide={guide}
      onGuideDone={() => setGuide(false)}
      background={<CameraFeed />}
      shortcut={<LookShortcut session={session} primary label="See my looks" onOpen={() => navigate(LOOK_PATH)} />}
    />
  );
}
