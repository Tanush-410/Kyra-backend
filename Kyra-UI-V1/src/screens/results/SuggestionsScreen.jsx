import { useEffect, useRef, useState } from "react";
import { SHOP_DEMO } from "../../config.js";
import { useHandSwipe, usePinchDrop } from "../../hooks/useHandSwipe.js";
import { useProductPhotos } from "../../hooks/useProductPhotos.js";
import { addLookToCart } from "../../lib/lookCart.js";
import { flatLay } from "../../lib/flatLay.js";
import { useLocation, useNavigate } from "react-router-dom";
import CameraFeed from "../../components/CameraFeed.jsx";
import Dialog from "../../components/Dialog.jsx";
import KyraLoader from "../../components/KyraLoader.jsx";
import ShopHeader from "../../components/ShopHeader.jsx";
import Toast from "../../components/Toast.jsx";
import { useKyraSession } from "../../context/KyraSessionContext.jsx";
import { useResultsSession } from "../../hooks/useResultsSession.js";
import { useToast } from "../../hooks/useToast.js";
import { allOutfits, outfitCount, setStart } from "../../lib/outfits.js";
import { BYE_PATH, EDIT_LOOK_PATH, LOOK_PATH } from "../../lib/shopRoutes.js";
import { isDesigning } from "../../state/sessionReducer.js";
import "./SuggestionsScreen.css";

const icon = (name) => `${import.meta.env.BASE_URL}assets/icons/${name}`;
const SWIPE_PX = 120; // a drag this far left or right switches options
const HINT_MS = 3500;
const hintedSessions = new Set(); // the "swipe" hint shows once per visit

// Category -> label and a neutral icon (public/assets/icons).
const CATEGORY = {
  top: { label: "Top", icon: "tops.png" },
  bottom: { label: "Bottom", icon: "bottoms.png" },
  onepiece: { label: "One-piece", icon: "tops.png" },
  outerwear: { label: "Layer", icon: "tops.png" },
  shoes: { label: "Shoes", icon: "shoes.png" },
  accessory: { label: "Accessory", icon: "glasses.png" },
};
/** Relative luminance above 0.55: a light colour. */
function isLight(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return false;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(m[1].slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55;
}
const categoryOf = (item) => CATEGORY[item.category] || { label: item.category || "Piece", icon: "tops.png" };

/**
 * One piece of the outfit as a card: its colour swatch in place of a product photo (the backend has
 * no product images), then what it is. Figma: the "suggestion cards" items (2043:8144); styled like the
 * design's info cards until the Cart frames (export-2) give the exact item card.
 */
export function ItemCard({ item }) {
  const category = categoryOf(item);
  const tags = [item.fit, item.material].filter(Boolean);
  return (
    <li className="suggest__item">
      <span className={`suggest__swatch${isLight(item.hex) ? " suggest__swatch--light" : ""}`} style={{ background: item.hex || "#777" }}>
        <img src={icon(category.icon)} alt="" />
      </span>
      <div className="suggest__item-text">
        <span className="suggest__category">{category.label}</span>
        <span className="suggest__name">{item.name}</span>
        {item.colorName && (
          <span className="suggest__colour">
            <i style={{ background: item.hex }} />
            {item.colorName}
          </span>
        )}
        {tags.length > 0 && (
          <span className="suggest__tags">
            {tags.map((tag) => (
              <span key={tag}>{tag}</span>
            ))}
          </span>
        )}
      </div>
    </li>
  );
}

// The outfit area's top left on the screen (.suggest__outfit): flat lay boxes are given in screen px.
const OUTFIT_LEFT = 124;
const OUTFIT_TOP = 718;

/**
 * The outfit as a flat lay of product photos, placed as in Figma's Suggestion frame (lib/flatLay.js).
 * photoFor(index): the piece's product photo, or null until it's made (or when photos are off): then the
 * piece shows as its colour with its category icon and name, in the same place.
 */
export function FlatLay({ items, photoFor = () => null }) {
  return (
    <span className="flatlay">
      {flatLay(items).map(({ item, index, slot, box }) => {
        const url = photoFor(index);
        const style = { left: box.left - OUTFIT_LEFT, top: box.top - OUTFIT_TOP, width: box.width, height: box.height };
        return (
          <span key={`${index}-${item.name}`} className={`flatlay__piece flatlay__piece--${slot}`} style={style}>
            {url ? (
              <img className="flatlay__photo" src={url} alt={`${item.colorName ? `${item.colorName} ` : ""}${item.name}`} />
            ) : (
              <span className={`flatlay__tile${isLight(item.hex) ? " flatlay__tile--light" : ""}`} style={{ background: item.hex || "#777" }}>
                <img src={icon(categoryOf(item).icon)} alt="" />
                <span className="flatlay__name">{item.name}</span>
              </span>
            )}
          </span>
        );
      })}
    </span>
  );
}

/** The outfit's pieces as cards (also the try-on screen's text-only and failed views). */
export function OutfitItems({ items }) {
  return (
    <ul className="suggest__items">
      {items.map((item) => (
        <ItemCard key={`${item.category}-${item.name}`} item={item} />
      ))}
    </ul>
  );
}

/**
 * Figma: "Suggestion to buy" / Suggestion (2043:8093, 8133, 8151) and its menu (2043:8110).
 * options: this round's outfits; index: the one shown. busy: a message while new looks are designed.
 */
export function SuggestionsView({ options, index, onIndex, onOpenMenu, busy, hint, count, lede = "Swipe for more options", background = null, header, outfitRef, draggable = false, photoFor }) {
  const option = options[index];
  const drag = useRef(null);
  const go = (step) => {
    const next = index + step;
    if (next >= 0 && next < options.length) onIndex(next);
  };
  const onPointerDown = (e) => {
    drag.current = { x: e.clientX, moved: false };
  };
  const onPointerUp = (e) => {
    const start = drag.current;
    drag.current = null;
    if (!start) return;
    // The screen is scaled to fit (ScreenFrame): compare in design pixels.
    const scale = e.currentTarget.getBoundingClientRect().width / e.currentTarget.offsetWidth || 1;
    const dx = (e.clientX - start.x) / scale;
    if (dx <= -SWIPE_PX) go(1);
    else if (dx >= SWIPE_PX) go(-1);
    else onOpenMenu();
  };

  return (
    <div className="screen suggest-screen" onKeyDown={(e) => (e.key === "ArrowRight" ? go(1) : e.key === "ArrowLeft" ? go(-1) : null)}>
      {background}
      {background && <div className="results-backdrop" />}
      {header}
      {busy || !option ? (
        <div className="suggest__busy">
          <KyraLoader label={busy || "Designing your looks"} />
          <p className="screen__text suggest__busy-text">{busy || "Kyra is designing your looks…"}</p>
        </div>
      ) : (
        <>
          {(options.length > 1 || lede !== "Swipe for more options") && <p className="suggest__hint">{lede}</p>}
          <h1 className="suggest__title">{option.title}</h1>
          {index > 0 && <span className="suggest__shade suggest__shade--left" aria-hidden="true" />}
          {index < options.length - 1 && <span className="suggest__shade suggest__shade--right" aria-hidden="true" />}
          <button
            type="button"
            ref={outfitRef}
            className="suggest__outfit"
            // Shop demo: pinch and drag the outfit to the cart (add) or the bin (discard).
            data-pinch-drag={draggable ? "" : undefined}
            aria-label={`${option.title}: options`}
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            onPointerCancel={() => (drag.current = null)}
            onClick={(e) => e.detail === 0 && onOpenMenu()}
          >
            <FlatLay items={option.items} photoFor={photoFor} />
          </button>
          <p className="suggest__count" aria-live="polite">
            {count || `${index + 1} of ${options.length}`}
          </p>
          <button type="button" className="suggest__arrow suggest__arrow--left" aria-label="Previous outfit" onClick={() => go(-1)} disabled={index === 0}>
            <img src={icon("arrow-left.svg")} alt="" width="74" height="74" />
          </button>
          <button type="button" className="suggest__arrow suggest__arrow--right" aria-label="Next outfit" onClick={() => go(1)} disabled={index >= options.length - 1}>
            <img src={icon("arrow-right.svg")} alt="" width="74" height="74" />
          </button>
          {hint && options.length > 1 && (
            <div className="suggest__swipe-hint" aria-hidden="true">
              <span className="suggest__chevrons">› › ›</span>
              <span>Swipe right to switch options</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function SuggestionsScreen() {
  const navigate = useNavigate();
  const location = useLocation();
  const session = useResultsSession();
  const { state, redesigning, tryOn, moreLike, addToCart } = useKyraSession();
  const outfitRef = useRef(null);
  const { toast, showToast } = useToast();
  const [index, setIndex] = useState(0);
  const [menu, setMenu] = useState(false);
  const [exitOpen, setExitOpen] = useState(false);
  const [asked, setAsked] = useState(null); // the round "More like this" was asked from
  const [hint, setHint] = useState(() => Boolean(session && !hintedSessions.has(session.id)));

  const round = session?.currentRound || 0;
  const outfits = allOutfits(session);
  const edited = Boolean(location.state?.edited);

  // A new set (an edit, More like this) opens at its first outfit; earlier sets stay a swipe away.
  useEffect(() => setIndex(setStart(allOutfits(session), round)), [round]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (asked != null && round > asked) setAsked(null);
  }, [asked, round]);
  useEffect(() => {
    if (!hint || !session || outfits.length < 2) return undefined;
    hintedSessions.add(session.id);
    const timer = setTimeout(() => setHint(false), HINT_MS);
    return () => clearTimeout(timer);
  }, [hint, session, outfits.length]);

  const at = Math.min(index, Math.max(0, outfits.length - 1));
  const option = outfits[at];
  const photoFor = useProductPhotos(option);
  const browsing = !menu && !exitOpen && asked == null;
  const step = (by) => {
    const next = at + by;
    if (next < 0 || next >= outfits.length) return;
    setIndex(next);
    setHint(false);
  };
  // Hand swipes (lib/handGestures.js): right for the next outfit, as the design's hint says.
  useHandSwipe((direction) => browsing && step(direction === "right" ? 1 : -1));
  // Shop demo: an outfit dragged to the cart adds its pieces (placeholder products); to the bin, it's skipped.
  usePinchDrop(outfitRef, async (target) => {
    if (!SHOP_DEMO || !option) return;
    if (target === "cart") {
      const added = await addLookToCart({ option, shop: state.shop, addToCart, photoFor });
      showToast(added ? "Outfit added to cart" : "These pieces are out of stock");
    } else if (target === "bin") {
      showToast("Item discarded");
      step(1);
    }
  });

  if (!session) return null;
  const designing = isDesigning(state.session, redesigning);
  const busy = asked != null ? "Finding more like this…" : "";

  const virtualTryOn = async () => {
    setMenu(false);
    await tryOn(option.round, option.option);
    navigate(LOOK_PATH);
  };
  const more = async () => {
    setMenu(false);
    if (designing) return;
    setAsked(round);
    const answer = await moreLike(option);
    if (!answer) {
      setAsked(null);
      showToast("Please try again", "error");
    }
  };

  return (
    <div className="suggest-wrap">
      <div inert={menu || exitOpen ? "" : undefined}>
        <SuggestionsView
          options={outfits}
          index={at}
          count={outfitCount(outfits, at)}
          // Figma "Extra" (2043:18385): after an edit, the new set asks.
          lede={edited && option?.round === round ? "Is this what you were looking for?" : "Swipe for more options"}
          onIndex={(i) => {
            setIndex(i);
            setHint(false);
          }}
          onOpenMenu={() => option && setMenu(true)}
          busy={busy}
          hint={hint}
          background={<CameraFeed />}
          header={
            <ShopHeader
              onExit={() => setExitOpen(true)}
              // Pinch and hold on the bin: the hold is the confirmation.
              onExitHold={() => {
                navigate(BYE_PATH, { replace: true }); // Bye ends the visit
              }}
            />
          }
          outfitRef={outfitRef}
          draggable={SHOP_DEMO}
          photoFor={photoFor}
        />
      </div>
      <Toast toast={toast} />
      {exitOpen && (
        <Dialog
          title="Exit"
          actions={[
            { label: "Keep looking", onClick: () => setExitOpen(false) },
            {
              label: "Exit",
              onClick: () => {
                navigate(BYE_PATH, { replace: true }); // Bye ends the visit
              },
            },
          ]}
        >
          <p>Are you sure you want to exit? Your photo and looks will be forgotten.</p>
        </Dialog>
      )}
      {menu && (
        <Dialog
          label={`${option.title}: options`}
          top={860}
          actions={[
            { label: "Virtual try-on", onClick: virtualTryOn },
            // An edit designs a new set of three around the change (one at a time, like More like this).
            {
              label: "Edit outfit",
              disabled: designing,
              onClick: () => {
                setMenu(false);
                navigate(EDIT_LOOK_PATH, { state: { round: option.round, option: option.option } });
              },
            },
            // One design call and one picture each: never while a round is being designed.
            { label: designing ? "Designing new looks…" : "More like this", onClick: more, disabled: designing },
            { label: "Back", onClick: () => setMenu(false) },
          ]}
        />
      )}
    </div>
  );
}
