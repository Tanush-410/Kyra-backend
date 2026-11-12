import { useParams } from "react-router-dom";
import AppHeader from "../components/AppHeader.jsx";
import Dialog from "../components/Dialog.jsx";
import KyraLoader from "../components/KyraLoader.jsx";
import Toast from "../components/Toast.jsx";

const noop = () => {};

/**
 * Development only (npm run dev): the shared pieces on a blank screen, for screenshot checks against
 * Figma. Not in the production build. Open /dev/<name>: header, toast, error, dialog, menu, loader.
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

export default function ComponentPreview() {
  const { name } = useParams();
  const Preview = PREVIEWS[name] || PREVIEWS.header;
  return (
    <div className="screen">
      <Preview />
    </div>
  );
}
