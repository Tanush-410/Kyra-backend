import { useState } from "react";
import { useParams } from "react-router-dom";
import AppHeader from "../components/AppHeader.jsx";
import Dialog from "../components/Dialog.jsx";
import KyraLoader from "../components/KyraLoader.jsx";
import Toast from "../components/Toast.jsx";
import { COPY } from "../lib/guidanceCopy.js";
import { ConsentView } from "../screens/onboarding/ConsentScreen.jsx";
import { HoldStillView } from "../screens/onboarding/HoldStillScreen.jsx";
import { FitAnalysisView } from "../screens/results/FitAnalysisScreen.jsx";
import { SkinToneView } from "../screens/results/SkinToneScreen.jsx";
import { SuggestionsView } from "../screens/results/SuggestionsScreen.jsx";
import { TryOnView } from "../screens/results/TryOnScreen.jsx";
import { EditView } from "../screens/results/EditLookScreen.jsx";
import EndScreen from "../components/EndScreen.jsx";
import { AccountView } from "../screens/shop/AccountScreen.jsx";
import LookShortcut from "../components/LookShortcut.jsx";
import { fitNotes } from "../lib/fitLevers.js";
import { KyraTagView } from "../screens/nfc/KyraTagScreen.jsx";
import { RateView } from "../screens/results/RateLookScreen.jsx";
import { useRef } from "react";
import ShopHeader from "../components/ShopHeader.jsx";
import { useKyraSession } from "../context/KyraSessionContext.jsx";
import { usePinchDrop } from "../hooks/useHandSwipe.js";
import { addLookToCart } from "../lib/lookCart.js";
import { cartSubtotal } from "../state/sessionReducer.js";

const noop = () => {};

/**
 * Development only (npm run dev): the shared pieces on a blank screen, for screenshot checks against
 * Figma. Not in the production build. Open /dev/<name>: header, toast, error, dialog, menu, loader;
 * whole screens: consent, consent-noqr, consent-error, too-far, out-of-frame, too-close, camera-loading,
 * hold, count, flash, allset, skin-tone, skin-analysing, fit, fit-guide, fit-outline, suggestions,
 * suggestions-2, suggestions-hint, suggestions-busy, tryon, tryon-loading, tryon-failed, tryon-text,
 * edit-piece, edit-piece-male, edit-intent, edit-voice, edit-working, edit-busy, great, perfect, bye,
 * still-here, rate, rate-open (a change open: tap or pinch outside it to close); Kyra Tags: tag-ask, tag-waiting, tag-writing, tag-done, tag-failed, tag-link.
 */
const QR_SAMPLE = "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#fff"/><path d="M1 1h3v3H1zM6 1h3v3H6zM1 6h3v3H1zM6 6h1v1H6zM8 8h1v1H8z"/></svg>');

const SAMPLE_RATING = {
  score: 6.5,
  verdict: "A clean base: three small changes lift it.",
  changes: [
    { id: 1, category: "shoes", name: "White leather sneakers", points: 1, tags: ["Clean", "Casual"], why: ["Lightens the whole look."], hex: "#f2f0ea" },
    { id: 2, category: "accessory", name: "A thin gold chain", points: 1, tags: ["Warm"], why: ["Picks up your warm undertone."], hex: "#c9a25a" },
    { id: 3, category: "hair", name: "Hair tucked behind the ears", points: 0.5, tags: [], why: [], hex: "#3a2a20" },
  ],
};

function RateOpenPreview() {
  const [open, setOpen] = useState(1);
  return <RateView now={new Date(2026, 10, 13, 15, 20)} weather={null} rating={SAMPLE_RATING} seen={new Set([1])} open={open} onOpen={setOpen} onClose={() => setOpen(null)} photoFor={() => null} final={false} onFinal={noop} onDone={noop} onKeep={noop} />;
}

/** Pick and drop on the try-on picture with the real drop handling (the cart is the real cart state). */
function TryOnDragPreview() {
  const lookRef = useRef(null);
  const { state, addToCart } = useKyraSession();
  const [last, setLast] = useState("");
  usePinchDrop(lookRef, async (target) => {
    if (target === "cart") {
      const added = await addLookToCart({ option: { ...SAMPLE_OPTIONS[0], round: 1, option: 1 }, shop: state.shop, addToCart });
      setLast(`cart: ${added} pieces`);
    } else setLast(`bin`);
  });
  return (
    <>
      <TryOnView view={{ kind: "ready", option: SAMPLE_OPTIONS[0], render: { imageDataUrl: `${import.meta.env.BASE_URL}assets/brand/fit-silhouette.png` } }} actions={TRYON_ACTIONS} header={<ShopHeader onExit={noop} />} lookRef={lookRef} draggable />
      <output id="drag-result" data-last={last} data-cart={state.shop.cart.length} data-total={cartSubtotal(state.shop)} data-prices={state.shop.cart.map((i) => i.price).join(",")} />
    </>
  );
}

const PREVIEWS = {
  "tryon-drag": () => <TryOnDragPreview />,
  "rate-open": () => <RateOpenPreview />,
  rate: () => <RateView now={new Date(2026, 10, 13, 15, 20)} weather={{ temperatureC: 14, kind: "cloudy" }} rating={SAMPLE_RATING} seen={new Set()} open={null} onOpen={noop} onClose={noop} photoFor={() => null} final={false} onFinal={noop} onDone={noop} onKeep={noop} />,
  "tag-ask": () => <KyraTagView stage="ask" />,
  "tag-waiting": () => <KyraTagView stage="job" status="waiting_for_tag" />,
  "tag-writing": () => <KyraTagView stage="job" status="writing" />,
  "tag-done": () => <KyraTagView stage="job" status="succeeded" />,
  "tag-failed": () => <KyraTagView stage="job" status="failed" error="tag_not_blank" />,
  "tag-link": () => <KyraTagView stage="link" link={{ url: "https://kyra.style/s/Ab3dE5gH7k", qrDataUrl: QR_SAMPLE }} />,
  header: () => <AppHeader onBin={noop} onCart={noop} onFilter={noop} />,
  toast: () => (
    <>
      <AppHeader onBin={noop} onCart={noop} />
      <Toast>Outfit added to cart</Toast>
    </>
  ),
  error: () => (
    <>
      <AppHeader onBin={noop} onCart={noop} />
      <Toast kind="error">Please try again</Toast>
    </>
  ),
  dialog: () => (
    <>
      <AppHeader onBin={noop} onCart={noop} />
      <Dialog
        title="Discard Item"
        actions={[
          { label: "Keep Item", onClick: noop },
          { label: "Remove from Cart", onClick: noop },
        ]}
      >
        <p>Are you sure you want to discard this item?</p>
      </Dialog>
    </>
  ),
  menu: () => (
    <>
      <AppHeader onBin={noop} onCart={noop} />
      <Dialog
        label="Options"
        actions={[
          { label: "Edit Outfit", onClick: noop },
          { label: "Virtual try-on", onClick: noop },
          { label: "More like this", onClick: noop },
        ]}
      />
    </>
  ),
  loader: () => (
    <>
      <AppHeader onBin={noop} onCart={noop} />
      <KyraLoader />
    </>
  ),
};

// A sample QR (any image works for a layout check; the real one comes from GET /api/v2/privacy).
const SAMPLE_QR = { url: "https://example.invalid/privacy", qrDataUrl: `${import.meta.env.BASE_URL}assets/brand/kyra-logo.png` };

// The Figma card's example colours (sampled from design/export-1, Component 80).
const FIGMA_COLOURS = [["Olive", "#6D6A4C"], ["Camel", "#A28268"], ["Deep Teal", "#445D62"], ["Plum", "#7C536C"], ["Terracotta", "#B25F49"]].map(([name, hex]) => ({ name, hex }));
const SAMPLE_VIEW = { undertone: "neutral", sure: true, olive: false, skinHex: "#CAB8A6", palette: FIGMA_COLOURS, metals: ["silver", "rose gold"], statement: "" };
const SAMPLE_SESSION = { rounds: { 1: [{ option: 1, title: "Look 1", items: [] }] }, currentRound: 1, active: { round: 1, option: 1 }, renders: { "1.1": { status: "rendering" } } };
const SAMPLE_FIT = fitNotes({ build: "medium", heightImpression: "average", heightCm: 168 }, ["Slim build: layers."]);
const shortcut = (primary) => <LookShortcut session={SAMPLE_SESSION} primary={primary} label={primary ? "See my looks" : undefined} onOpen={noop} />;

// Three outfits shaped like the backend's options (outfit-design.js).
const item = (category, name, colorName, hex, fit, material) => ({ category, name, colorName, hex, fit, material });
const SAMPLE_OPTIONS = [
  { option: 1, title: "Terracotta casual", summary: "", items: [item("top", "Relaxed cotton shirt", "Terracotta", "#C8643B", "relaxed", "cotton"), item("bottom", "High-rise straight jeans", "Camel", "#C19A6B", "straight", "denim"), item("outerwear", "Light knit cardigan", "Chocolate", "#5B3A29", "regular", "knit"), item("shoes", "Clean leather sneakers", "Camel", "#C19A6B", "", "leather")] },
  { option: 2, title: "Olive weekend", summary: "", items: [item("top", "Crew tee", "Olive", "#708238", "regular", "cotton"), item("bottom", "Wide-leg trousers", "Cream", "#EFE3C6", "wide", "linen"), item("shoes", "Loafers", "Brown", "#6B4423", "", "suede")] },
  { option: 3, title: "Teal evening", summary: "", items: [item("onepiece", "Wrap dress", "Teal", "#1F7A7A", "fitted", "silk"), item("shoes", "Block heels", "Gold", "#C9A227", "", "leather"), item("accessory", "Small clutch", "Rust", "#B7410E", "", "leather")] },
];

const TRYON_ACTIONS = { onMenu: noop, onRetry: noop, onAnother: noop, onSuggestions: noop };
const EDIT_ACTIONS = { onPiece: noop, onIntent: noop, onListen: noop, onWords: noop, onBack: noop };

/** Whole screens (they draw their own .screen). */
const SCREENS = {
  consent: () => <ConsentView qr={SAMPLE_QR} onContinue={noop} />,
  "consent-noqr": () => <ConsentView qr={null} onContinue={noop} />,
  "consent-error": () => <ConsentView qr={SAMPLE_QR} error="The mirror’s camera isn’t available right now." onContinue={noop} />,
  "too-far": () => <HoldStillView view={{ kind: "guide", copy: COPY["too-far"] }} />,
  "out-of-frame": () => <HoldStillView view={{ kind: "guide", copy: COPY["out-of-frame"] }} />,
  "too-close": () => <HoldStillView view={{ kind: "guide", copy: COPY["too-close"] }} />,
  "camera-loading": () => <HoldStillView view={{ kind: "loading" }} />,
  hold: () => <HoldStillView view={{ kind: "hold" }} />,
  count: () => <HoldStillView view={{ kind: "count", count: 3 }} />,
  flash: () => <HoldStillView view={{ kind: "flash" }} />,
  allset: () => <HoldStillView view={{ kind: "allset" }} />,
  "skin-tone": () => <SkinToneView view={SAMPLE_VIEW} depth="medium" shortcut={shortcut(false)} onKnowMore={noop} onKnowFit={noop} />,
  "skin-analysing": () => <SkinToneView view={null} shortcut={shortcut(false)} />,
  fit: () => <FitAnalysisView goal="longer" onGoal={noop} notes={SAMPLE_FIT} female shortcut={shortcut(true)} />,
  "fit-guide": () => <FitAnalysisView goal="longer" onGoal={noop} notes={SAMPLE_FIT} female guide onGuideDone={noop} shortcut={shortcut(true)} />,
  suggestions: () => <SuggestionsView options={SAMPLE_OPTIONS} index={0} onIndex={noop} onOpenMenu={noop} header={<AppHeader onBin={noop} />} />,
  "suggestions-2": () => <SuggestionsView options={SAMPLE_OPTIONS} index={1} onIndex={noop} onOpenMenu={noop} header={<AppHeader onBin={noop} />} />,
  "suggestions-hint": () => <SuggestionsView options={SAMPLE_OPTIONS} index={0} hint onIndex={noop} onOpenMenu={noop} header={<AppHeader onBin={noop} />} />,
  "suggestions-busy": () => <SuggestionsView options={SAMPLE_OPTIONS} index={0} busy="Finding more like this…" onIndex={noop} onOpenMenu={noop} header={<AppHeader onBin={noop} />} />,
  "tryon": () => <TryOnView view={{ kind: "ready", option: SAMPLE_OPTIONS[0], render: { imageDataUrl: `${import.meta.env.BASE_URL}assets/brand/fit-silhouette.png` } }} actions={TRYON_ACTIONS} header={<AppHeader onBin={noop} />} />,
  "tryon-loading": () => <TryOnView view={{ kind: "loading", caption: "Your look is next in line…" }} actions={TRYON_ACTIONS} header={<AppHeader onBin={noop} />} />,
  "tryon-failed": () => <TryOnView view={{ kind: "failed", option: SAMPLE_OPTIONS[1], message: "I couldn’t create this picture. Try another look." }} actions={TRYON_ACTIONS} header={<AppHeader onBin={noop} />} />,
  "tryon-text": () => <TryOnView view={{ kind: "text", option: SAMPLE_OPTIONS[2], message: "Pictures are unavailable right now, so here is your look in words." }} actions={TRYON_ACTIONS} header={<AppHeader onBin={noop} />} />,
  "edit-piece": () => <EditView step="piece" gender="female" outfit="Editing “Olive weekend”" {...EDIT_ACTIONS} />,
  "edit-piece-male": () => <EditView step="piece" gender={null} outfit="Editing “Olive weekend”" {...EDIT_ACTIONS} />,
  "edit-intent": () => <EditView step="intent" {...EDIT_ACTIONS} />,
  "edit-voice": () => <EditView step="voice" {...EDIT_ACTIONS} />,
  "edit-working": () => <EditView step="working" {...EDIT_ACTIONS} />,
  "edit-busy": () => <EditView step="intent" busy {...EDIT_ACTIONS} />,
  account: () => <AccountView view={{ kind: "ready", qr: SAMPLE_QR }} onBack={noop} header={<AppHeader onBin={noop} />} />,
  "account-waiting": () => <AccountView view={{ kind: "message", text: "Your skin tone and fit results appear here once Kyra has taken your photo." }} onBack={noop} header={<AppHeader onBin={noop} />} />,
  great: () => <EndScreen title="Great" text="You look beautiful today" onTap={noop} />,
  perfect: () => <EndScreen title="Perfect" text="You look gorgeous!" onTap={noop} />,
  bye: () => <EndScreen title="Bye" text="Have a nice day." />,
  "still-here-away": () => <EndScreen title="Still here?" text="We’ll delete your session in 30 seconds." note="I can’t see you. Step in front of the mirror to stay." actions={[{ label: "Still Here", onClick: noop }, { label: "Delete Session", onClick: noop }]} />,
  "still-here": () => <EndScreen title="Still here?" text="We’ll delete your session in 30 seconds." actions={[{ label: "Still Here", onClick: noop }, { label: "Delete Session", onClick: noop }]} />,
  "fit-outline": () => <FitAnalysisView goal="balance" onGoal={noop} notes={SAMPLE_FIT} female={false} shortcut={shortcut(true)} />,
};

export default function ComponentPreview() {
  const { name } = useParams();
  if (SCREENS[name]) {
    const Screen = SCREENS[name];
    return <Screen />;
  }
  const Preview = PREVIEWS[name] || PREVIEWS.header;
  return (
    <div className="screen">
      <Preview />
    </div>
  );
}
