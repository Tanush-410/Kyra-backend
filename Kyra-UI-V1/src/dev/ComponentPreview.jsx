import { useParams } from "react-router-dom";
import AppHeader from "../components/AppHeader.jsx";
import Dialog from "../components/Dialog.jsx";
import KyraLoader from "../components/KyraLoader.jsx";
import Toast from "../components/Toast.jsx";
import { COPY } from "../lib/guidanceCopy.js";
import { ConsentView } from "../screens/onboarding/ConsentScreen.jsx";
import { HoldStillView } from "../screens/onboarding/HoldStillScreen.jsx";

const noop = () => {};

/**
 * Development only (npm run dev): the shared pieces on a blank screen, for screenshot checks against
 * Figma. Not in the production build. Open /dev/<name>: header, toast, error, dialog, menu, loader;
 * whole screens: consent, consent-noqr, consent-error, too-far, out-of-frame, too-close, camera-loading,
 * hold, count, flash, allset.
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
