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
import LookShortcut from "../components/LookShortcut.jsx";
import { fitNotes } from "../lib/fitLevers.js";

const noop = () => {};

/**
 * Development only (npm run dev): the shared pieces on a blank screen, for screenshot checks against
 * Figma. Not in the production build. Open /dev/<name>: header, toast, error, dialog, menu, loader;
 * whole screens: consent, consent-noqr, consent-error, too-far, out-of-frame, too-close, camera-loading,
 * hold, count, flash, allset, skin-tone, skin-analysing, fit, fit-guide, fit-outline, suggestions,
 * suggestions-2, suggestions-hint, suggestions-busy, tryon, tryon-loading, tryon-failed, tryon-text.
 */
const PREVIEWS = {
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
