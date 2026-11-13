import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { kyraApi } from "../../api/kyraClient.js";
import CameraFeed from "../../components/CameraFeed.jsx";
import KyraLoader from "../../components/KyraLoader.jsx";
import OptionCard from "../../components/OptionCard.jsx";
import Toast from "../../components/Toast.jsx";
import { useKyraSession } from "../../context/KyraSessionContext.jsx";
import { useProductPhotos } from "../../hooks/useProductPhotos.js";
import { useResultsSession } from "../../hooks/useResultsSession.js";
import { useToast } from "../../hooks/useToast.js";
import { BYE_PATH } from "../../lib/shopRoutes.js";
import { keyOf } from "../../state/sessionReducer.js";
import "./RateLookScreen.css";

const icon = (name) => `${import.meta.env.BASE_URL}assets/icons/${name}`;
// The round icons on the left, in the design's colours until the change has been seen (then white).
const RINGS = ["#ff5757", "#dfa678", "#a9d68f"];
const LABEL = { shoes: "Footwear", hair: "Hairstyle", accessory: "Jewellery", bag: "Bag", outerwear: "Layer", top: "Top", bottom: "Bottoms" };
// Lower-body changes put the card above the photo (Figma: White Kitten Heels); the rest, the photo first.
const CARD_FIRST = new Set(["shoes", "bottom", "bag"]);

export function greeting(date = new Date()) {
  const h = date.getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}
const dayLine = (d) => d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "long" });
const timeLine = (d) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

function ChangeIcon({ category }) {
  if (category === "hair") {
    return (
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <path d="M14 36 L36 14" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
        <path d="M18 40 L40 18 M21 21 l-5 -5 M25 17 l-5 -5 M29 13 l-5 -5" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
    );
  }
  if (category === "accessory") {
    return (
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <circle cx="24" cy="29" r="11" fill="none" stroke="currentColor" strokeWidth="4" />
        <path d="M18 14 l6 -6 l6 6 l-6 6 z" fill="none" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" />
      </svg>
    );
  }
  const file = { shoes: "shoes.png", bag: "bag-women.png", bottom: "bottoms.png" }[category] || "tops.png";
  return <img src={icon(file)} alt="" />;
}

/** "7/10", one decimal only when needed. */
const scoreText = (n) => `${Number.isInteger(n) ? n : n.toFixed(1)}/10`;

/**
 * Figma: "Rate and changes". The mirror rates the outfit the visitor is wearing, suggests three changes
 * (round icons on the left), and each change viewed raises the score; the last screen shows the visitor in
 * their own outfit with the changes (one render, made in the background meanwhile).
 */
export function RateView({ now, weather, rating, seen, open, onOpen, onClose, photoFor, final, render, onFinal, onDone, onKeep, error }) {
  const score = rating ? Math.min(10, Math.round((rating.score + rating.changes.filter((c) => seen.has(c.id)).reduce((s, c) => s + c.points, 0)) * 10) / 10) : null;
  const change = open != null ? rating?.changes.find((c) => c.id === open) : null;
  return (
    <div className="screen rate">
      {final && render?.imageDataUrl ? <img className="rate__look" src={render.imageDataUrl} alt="You with the changes" /> : <CameraFeed />}
      <div className={`rate__shade${change || (final && !render?.imageDataUrl) ? " rate__shade--blur" : ""}`} />

      <header className="rate__head">
        <p className="rate__hello">{greeting(now)}</p>
        <div className="rate__when">
          <span>{dayLine(now)}</span>
          <span>{timeLine(now)}</span>
          {weather && (
            <span className="rate__weather">
              <svg viewBox="0 0 40 28" aria-hidden="true">
                {weather.kind !== "cloudy" && weather.kind !== "rain" && <circle cx="26" cy="11" r="8" fill="#f6c453" />}
                {weather.kind !== "clear" && <path d="M8 26 h22 a6 6 0 0 0 0 -12 a8 8 0 0 0 -15 -2 a6 6 0 0 0 -7 14 z" fill="#cfd4da" />}
              </svg>
              {weather.temperatureC}°
            </span>
          )}
        </div>
        <img className="rate__star" src={icon("kyra-star.png")} alt="" />
      </header>

      {error ? (
        <div className="rate__middle">
          <p className="rate__lede">{error}</p>
        </div>
      ) : !rating ? (
        <div className="rate__middle">
          <KyraLoader label="Rating your look" />
          <p className="rate__lede">Kyra is looking at your outfit…</p>
        </div>
      ) : (
        <>
          <p className="rate__score" aria-live="polite">{scoreText(final ? rating.finalScore : score)}</p>
          {!final && <p className="rate__lede">Make these changes to elevate the look</p>}
          {final && !render?.imageDataUrl && (
            <div className="rate__middle rate__middle--low">
              <KyraLoader label="Creating your new look" />
              <p className="rate__lede">{render?.status === "failed" ? render.error || "I couldn’t create this picture." : "Putting the changes on you…"}</p>
            </div>
          )}
          <ul className="rate__icons">
            {rating.changes.map((c, i) => (
              <li key={c.id}>
                <button
                  type="button"
                  className="rate__icon"
                  style={{ borderColor: seen.has(c.id) || final ? "#fff" : RINGS[i % RINGS.length] }}
                  aria-label={`${LABEL[c.category] || c.category}: ${c.name}`}
                  onClick={() => (open === c.id ? onClose() : onOpen(c.id))}
                >
                  <ChangeIcon category={c.category} />
                </button>
              </li>
            ))}
          </ul>

          {change && (
            <div className={`rate__change${CARD_FIRST.has(change.category) ? "" : " rate__change--photo-first"}`} onClick={onClose} role="presentation">
              <article className="rate__card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={change.name}>
                <span className="rate__brand">{LABEL[change.category] || change.category}</span>
                <h2 className="rate__name">{change.name}</h2>
                <span className="rate__points">
                  +{change.points}
                  <small>{change.points === 1 ? "Point" : "Points"}</small>
                </span>
                {change.tags.length > 0 && (
                  <ul className="rate__tags">
                    {change.tags.map((t) => (
                      <li key={t.label}>
                        {t.label} : {t.value}
                      </li>
                    ))}
                  </ul>
                )}
                {change.why.length > 0 && <p className="rate__why">“{change.why.join("\n")}”</p>}
              </article>
              <div className="rate__photo">
                {photoFor(change.id - 1) ? (
                  <img src={photoFor(change.id - 1)} alt="" />
                ) : (
                  <span className="rate__photo-tile" style={{ background: change.hex }}>
                    <ChangeIcon category={change.category} />
                  </span>
                )}
              </div>
            </div>
          )}

          <div className="rate__buttons">
            {final ? (
              <>
                <OptionCard label="Take it home" width="w840" onClick={onKeep} disabled={!render?.imageDataUrl} />
                <OptionCard label="I’m done" width="w840" onClick={onDone} />
              </>
            ) : (
              <>
                <OptionCard label={seen.size < rating.changes.length ? "Show the next change" : "See my new look"} width="w840" onClick={onFinal} />
                <OptionCard label="I’m done" width="w840" onClick={onDone} />
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default function RateLookScreen() {
  const navigate = useNavigate();
  const session = useResultsSession();
  const { keep } = useKyraSession();
  const { toast, showToast } = useToast();
  const [now, setNow] = useState(() => new Date());
  const [weather, setWeather] = useState(null);
  const [seen, setSeen] = useState(() => new Set());
  const [open, setOpen] = useState(null);
  const [final, setFinal] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    kyraApi.context().then((answer) => setWeather(answer?.weather || null)).catch(() => {});
    return () => clearInterval(timer);
  }, []);

  const rating = session?.rateLook || null;
  // The changes' round (the backend makes it the visit's only round).
  const round = useMemo(() => Number(Object.keys(session?.rounds || {})[0]) || 1, [session?.rounds]);
  const option = session?.rounds?.[round]?.[0] ? { ...session.rounds[round][0], round } : null;
  const photoFor = useProductPhotos(option);
  if (!session) return null;
  const render = session.renders?.[keyOf(round, 1)] || null;

  const view = (id) => {
    setOpen(id);
    setSeen((done) => new Set(done).add(id));
  };
  const next = () => {
    const unseen = rating.changes.find((c) => !seen.has(c.id));
    if (unseen) view(unseen.id);
    else {
      setOpen(null);
      setFinal(true);
    }
  };
  const takeHome = async () => {
    const kept = await keep();
    if (kept?.qrDataUrl) showToast("Scan the code on the next screen");
  };

  return (
    <div className="rate-wrap">
      <RateView
        now={now}
        weather={weather}
        rating={rating}
        seen={seen}
        open={open}
        onOpen={view}
        onClose={() => setOpen(null)}
        photoFor={photoFor}
        final={final}
        render={render}
        onFinal={next}
        onDone={() => navigate(BYE_PATH, { replace: true })}
        onKeep={takeHome}
        error={session.status === "error" && !rating ? session.error : ""}
      />
      {session.kept?.qrDataUrl && final && (
        <div className="rate__qr" role="dialog" aria-label="Take your look home">
          <img src={session.kept.qrDataUrl} alt="QR code for your look" />
          <p>Scan to take your look home</p>
        </div>
      )}
      <Toast toast={toast} />
    </div>
  );
}
