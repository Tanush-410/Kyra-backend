import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import AppHeader from "../../components/AppHeader.jsx";
import CameraFeed from "../../components/CameraFeed.jsx";
import Dialog from "../../components/Dialog.jsx";
import EndScreen from "../../components/EndScreen.jsx";
import KyraLoader from "../../components/KyraLoader.jsx";
import OptionCard from "../../components/OptionCard.jsx";
import ShopHeader from "../../components/ShopHeader.jsx";
import Toast from "../../components/Toast.jsx";
import { SHOP_DEMO } from "../../config.js";
import { useKyraSession } from "../../context/KyraSessionContext.jsx";
import { usePinchDrop } from "../../hooks/useHandSwipe.js";
import { useProductPhotos } from "../../hooks/useProductPhotos.js";
import { useToast } from "../../hooks/useToast.js";
import { addLookToCart } from "../../lib/lookCart.js";
import { BYE_PATH, EDIT_PATH, SHOP_PATH, SUGGESTIONS_PATH } from "../../lib/shopRoutes.js";
import { KYRA_TAG_PATH } from "../../lib/nfcRoutes.js";
import { nextOptionOf, tryOnState } from "../../lib/tryOnView.js";
import { keyOf, phaseOf } from "../../state/sessionReducer.js";
import { OutfitItems } from "./SuggestionsScreen.jsx";
import "./TryOnScreen.css";

const HOME = "/";
const PRAISE_MS = 3000;
const PRAISE = [
  { title: "Great", text: "You look beautiful today" },
  { title: "Perfect", text: "You look gorgeous!" },
];

/**
 * Figma: "Virtual try on" (2043:13475): the visitor wearing the look, full height under the header.
 * While it is made: the Kyra star ("Splash state" 2043:13484). When the picture can't be made, or
 * pictures are off (text-only mode): the outfit as cards and the reason ("Error" 2043:13400, with
 * "Please try again"), always with a way on: try again, another look, or back to the suggestions.
 *
 * view: tryOnState(session). actions: { onMenu, onRetry, onAnother, onSuggestions }.
 * lookRef, draggable: the picture can be pinched and dragged onto the cart (its pieces, with prices) or the
 * bin (not for me: the next look). A plain pinch on it still opens the options.
 */
export function TryOnView({ view, actions, header, background = null, preview = null, lookRef = null, draggable = false }) {
  const { onMenu, onRetry, onAnother, onSuggestions } = actions;
  if (view.kind === "ready") {
    return (
      <div className="screen tryon">
        {header}
        <button
          type="button"
          ref={lookRef}
          className="tryon__look"
          onClick={onMenu}
          aria-label={`You in ${view.option.title}: options`}
          data-pinch-drag={draggable ? "" : undefined}
        >
          <img src={view.render.imageDataUrl} alt="" />
        </button>
        <button type="button" className="outline-button tryon__options" onClick={onMenu}>
          Options
        </button>
      </div>
    );
  }
  if (view.kind === "loading") {
    return (
      <div className="screen tryon">
        {background}
        {background && <div className="results-backdrop" />}
        {header}
        {preview && <img className="tryon__preview" src={preview} alt="" />}
        <KyraLoader label={view.caption} />
        <p className="screen__text tryon__caption" role="status">
          {view.caption}
        </p>
        <div className="tryon__way">
          <button type="button" className="outline-button" onClick={onSuggestions}>
            Back to suggestions
          </button>
        </div>
      </div>
    );
  }
  // failed or text: the outfit in words, the reason, and the ways on
  return (
    <div className="screen tryon">
      {background}
      {background && <div className="results-backdrop" />}
      {header}
      <Toast kind="error">{view.kind === "failed" ? "Please try again" : "Pictures are paused"}</Toast>
      <h1 className="tryon__title">{view.option.title}</h1>
      <p className="tryon__reason">{view.message}</p>
      <div className="tryon__outfit">
        <OutfitItems items={view.option.items} />
      </div>
      <div className="tryon__actions">
        {view.kind === "failed" && <OptionCard label="Try again" width="w840" onClick={onRetry} />}
        {onAnother && <OptionCard label="Try another look" width="w840" onClick={onAnother} />}
        <OptionCard label="Back to suggestions" width="w840" onClick={onSuggestions} />
      </div>
    </div>
  );
}

export default function TryOnScreen() {
  const navigate = useNavigate();
  const { state, like, showAnother, keep, tryOn, saveOutfit, addToCart } = useKyraSession();
  const { toast, showToast } = useToast();
  const session = state.session;
  const phase = phaseOf(session);
  const [menu, setMenu] = useState(false);
  const [exitOpen, setExitOpen] = useState(false);
  const [closedQr, setClosedQr] = useState(null);
  const [praise, setPraise] = useState(null); // index into PRAISE while it shows
  const lookRef = useRef(null);
  const lookOption = session && phase === "results" ? tryOnState(session).option : null;
  const photoFor = useProductPhotos(lookOption);

  // Pick and drop (pinch and drag the picture): onto the cart, the look's pieces go in with their prices;
  // onto the bin, it's "not for me" (a thumbs-down that teaches the mirror) and the next look comes up.
  usePinchDrop(lookRef, async (target) => {
    if (!SHOP_DEMO || !lookOption) return;
    if (target === "cart") {
      const added = await addLookToCart({ option: lookOption, shop: state.shop, addToCart, photoFor });
      showToast(added ? "Outfit added to cart" : "These pieces are out of stock");
    } else if (target === "bin") {
      showToast("Look discarded");
      if (nextOptionOf(session)) await showAnother();
      else navigate(SUGGESTIONS_PATH);
    }
  });

  // The visit ended (stepped away, timed out, someone else): "Bye", then the start.
  useEffect(() => {
    if (phase === "ended") navigate(BYE_PATH, { replace: true });
    else if (phase === "none") navigate(HOME, { replace: true });
  }, [phase, navigate]);

  // Figma "Confirmation" (2043:13358, 13374): after a like, from the menu or a thumbs-up, for 3 s.
  const activeKeyNow = session?.active ? keyOf(session.active.round, session.active.option) : null;
  const likedNow = Boolean(activeKeyNow && session?.ratings[activeKeyNow] === "up");
  const likedBefore = useRef({ key: activeKeyNow, liked: likedNow });
  useEffect(() => {
    const before = likedBefore.current;
    likedBefore.current = { key: activeKeyNow, liked: likedNow };
    if (likedNow && !(before.key === activeKeyNow && before.liked)) {
      setPraise((n) => (n == null ? 0 : (n + 1) % PRAISE.length));
    }
  }, [activeKeyNow, likedNow]);
  useEffect(() => {
    if (praise == null) return undefined;
    const timer = setTimeout(() => setPraise(null), PRAISE_MS);
    return () => clearTimeout(timer);
  }, [praise]);

  if (!session) return null;
  // Bye ends the visit when it opens: ending it here first would send this screen home instead.
  // "I'm done": "Would you like a Kyra Tag?" first (it goes on to Bye, which ends the visit).
  const finish = () => {
    navigate(KYRA_TAG_PATH, { replace: true });
  };

  if (phase === "ended") return null;
  if (phase === "error") {
    return (
      <div className="screen">
        <AppHeader />
        <div className="screen__content tryon__ended">
          <h1 className="title">Something went wrong</h1>
          <p className="screen__text">{session.error}</p>
          {/* A failed visit: no Kyra Tag offer, straight to Bye. */}
          <OptionCard label="Start again" width="w500" onClick={() => navigate(BYE_PATH, { replace: true })} />
        </div>
      </div>
    );
  }

  const view = tryOnState(session);
  const active = session.active;
  const activeKey = active ? keyOf(active.round, active.option) : null;
  const liked = activeKey && session.ratings[activeKey] === "up";
  const kept = session.kept && activeKey && keyOf(session.kept.round, session.kept.option) === activeKey ? session.kept : null;
  const qrOpen = Boolean(kept?.qrDataUrl && closedQr !== kept.url);
  const next = nextOptionOf(session);
  const modal = menu || exitOpen || qrOpen || praise != null;

  const close = (fn) => async () => {
    setMenu(false);
    await fn();
  };
  const menuActions = [
    { label: liked ? "Loved it ♥" : "Love it", disabled: liked, onClick: close(like) },
    { label: "Take it home", onClick: close(keep) },
    ...(next ? [{ label: "Show another", onClick: close(showAnother) }] : []),
    { label: "Back to suggestions", onClick: close(() => navigate(SUGGESTIONS_PATH)) },
    // The shop demo only (VITE_SHOP_DEMO): placeholder prices.
    ...(SHOP_DEMO
      ? [
          { label: "Shop this look", onClick: close(() => navigate(SHOP_PATH)) },
          { label: "Edit this look", onClick: close(() => navigate(EDIT_PATH)) },
          {
            label: "Save outfit",
            onClick: close(() => {
              saveOutfit({ key: activeKey, round: active.round, option: active.option, title: view.option.title, summary: view.option.summary, items: view.option.items, imageDataUrl: view.render?.imageDataUrl || null });
              showToast("Outfit saved successfully");
            }),
          },
        ]
      : []),
    { label: "Back", onClick: () => setMenu(false) },
  ];

  return (
    <div className="tryon-wrap">
      <div inert={modal ? "" : undefined}>
        <TryOnView
          view={view}
          preview={view.render?.preview || null}
          background={<CameraFeed />}
          header={<ShopHeader onExit={() => setExitOpen(true)} onExitHold={finish} />}
          lookRef={lookRef}
          draggable={SHOP_DEMO}
          actions={{
            onMenu: () => setMenu(true),
            onRetry: () => tryOn(active.round, active.option),
            onAnother: next ? () => tryOn(next.round, next.option) : null,
            onSuggestions: () => navigate(SUGGESTIONS_PATH),
          }}
        />
      </div>
      {praise != null && (
        <div className="tryon__praise">
          <EndScreen live title={PRAISE[praise].title} text={PRAISE[praise].text} onTap={() => setPraise(null)} />
        </div>
      )}
      {session.actionError && <Toast kind="error">{session.actionError}</Toast>}
      <Toast toast={toast} />

      {menu && <Dialog label={`${view.option?.title || "Your look"}: options`} top={790} actions={menuActions} />}

      {qrOpen && (
        <Dialog
          title="Scan to take your look home"
          top={600}
          actions={[
            { label: "Keep browsing", onClick: () => setClosedQr(kept.url) },
            { label: "I’m done", onClick: finish },
          ]}
        >
          <img className="tryon__qr" src={kept.qrDataUrl} alt="QR code for your look" width="560" height="560" />
          {kept.expiresAt && (
            <p>The link works until {new Date(kept.expiresAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}.</p>
          )}
        </Dialog>
      )}

      {exitOpen && (
        <Dialog
          title="Exit"
          actions={[
            { label: "Keep looking", onClick: () => setExitOpen(false) },
            { label: "Exit", onClick: finish },
          ]}
        >
          <p>Are you sure you want to exit? Your photo and looks will be forgotten.</p>
        </Dialog>
      )}
    </div>
  );
}
