import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import OptionCard from "../../components/OptionCard.jsx";
import ProductCard from "../../components/ProductCard.jsx";
import ShopHeader from "../../components/ShopHeader.jsx";
import Toast from "../../components/Toast.jsx";
import { useKyraSession } from "../../context/KyraSessionContext.jsx";
import {
  categoryLabel,
  productFromItem,
  productsForLook,
  replacementProduct,
} from "../../data/shopPlaceholders.js";
import { useSessionGuard } from "../../hooks/useSessionGuard.js";
import { useSpeechToText } from "../../hooks/useSpeechToText.js";
import { useToast } from "../../hooks/useToast.js";
import { RESULTS_PATH, SHOP_PATH } from "../../lib/shopRoutes.js";
import { activeOption, editsForLook, keyOf } from "../../state/sessionReducer.js";
import "./shop.css";

const CATEGORIES = [
  { key: "top", label: "Tops", icon: "tops" },
  { key: "bottom", label: "Bottoms", icon: "bottoms" },
  { key: "onepiece", label: "Dresses", icon: "dress-women" },
  { key: "shoes", label: "Shoes", icon: "shoes" },
  { key: "accessory", label: "Accessories", icon: "bag-women" },
];

const THOUGHTS = [
  { id: "similar", label: "Something similar" },
  { id: "different", label: "Something different" },
  { id: "suggest", label: "Suggest changes" },
  { id: "know", label: "I know what I want" },
];

const PRESETS = ["More structured", "More colour", "More casual", "More minimal"];

const SINGULAR = { top: "top", bottom: "bottom", onepiece: "dress", shoes: "shoe", accessory: "accessory" };

function VoiceCapture({ onDone }) {
  const speech = useSpeechToText({ onDone, noSpeechMs: 8000 });
  if (speech.status === "unsupported") return <p className="edit__voice">Voice isn't available in this browser. Type or pick a suggestion.</p>;
  if (speech.status === "error") return <p className="edit__voice">Voice stopped ({speech.error}). Type or pick a suggestion.</p>;
  return (
    <p className="edit__voice">
      Listening… {speech.finalText} {speech.interim}
    </p>
  );
}

/** Figma: "Edit" — three steps per piece. Replacements are placeholders until the catalogue exists. */
export default function EditScreen() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const session = useSessionGuard();
  const { state, editPiece } = useKyraSession();
  const { toast, showToast } = useToast();

  const queryCategory = searchParams.get("category");
  const initialCategory = CATEGORIES.some((entry) => entry.key === queryCategory) ? queryCategory : null;
  const [category, setCategory] = useState(initialCategory);
  const [step, setStep] = useState(initialCategory ? 2 : 1);
  const [mode, setMode] = useState(null);
  const [requestKind, setRequestKind] = useState(null);
  const [text, setText] = useState("");
  const [listening, setListening] = useState(false);
  const [variant, setVariant] = useState(0);

  const option = activeOption(session);
  const round = session?.active?.round ?? session?.currentRound ?? 0;
  const lookKey = option ? keyOf(round, option.option) : null;
  const products = option ? productsForLook(option, lookKey, editsForLook(state.shop, lookKey)) : [];
  const baseProduct =
    (category && products.find((product) => product.category === category)) ||
    (category
      ? productFromItem(
          { category, name: categoryLabel(category), colorName: "Neutral" },
          { lookKey: lookKey || "edit", index: 99 },
        )
      : null);
  const variantOffset = mode === "different" ? 1 : 0;
  const replacement = baseProduct ? replacementProduct(baseProduct, variant + variantOffset, text) : null;

  const chooseCategory = (key) => {
    setCategory(key);
    setMode(null);
    setRequestKind(null);
    setVariant(0);
    setStep(2);
  };

  const chooseThought = (id) => {
    setVariant(0);
    if (id === "suggest" || id === "know") {
      setRequestKind(id);
      setMode("request");
      setStep("request");
      return;
    }
    setMode(id);
    setStep(3);
  };

  const pick = () => {
    if (!lookKey || !category || !replacement) {
      showToast("This look isn't ready yet");
      return;
    }
    editPiece({ key: lookKey, category, product: replacement });
    showToast("Piece updated");
    navigate(SHOP_PATH);
  };

  const back = () => {
    if (step === "request") {
      setStep(2);
      return;
    }
    if (step === 3) {
      setStep(mode === "request" ? "request" : 2);
      return;
    }
    setStep(1);
  };

  if (!session) return <div className="screen" />;

  return (
    <div className="screen">
      <ShopHeader />
      <main className="screen__content shop">
        {step === 1 && (
          <>
            <h1 className="title title--h4">What would you like to edit?</h1>
            <p className="edit__intro">Pick the piece you want to change. You'll choose how in the next step.</p>
            <div className="option-grid">
              {CATEGORIES.map((entry, index) => (
                <div key={entry.key} className={index === CATEGORIES.length - 1 ? "option-grid__span" : undefined}>
                  <OptionCard
                    label={entry.label}
                    icon={`${import.meta.env.BASE_URL}assets/icons/${entry.icon}.png`}
                    iconWidth={150}
                    width="w500"
                    onClick={() => chooseCategory(entry.key)}
                  />
                </div>
              ))}
            </div>
            <button type="button" className="shop-button shop-button--ghost" onClick={() => navigate(RESULTS_PATH)}>
              Cancel
            </button>
          </>
        )}

        {step === 2 && (
          <>
            <h1 className="title title--h4">What's on your mind?</h1>
            <p className="edit__intro">Editing: {categoryLabel(category)}</p>
            <div className="option-grid">
              {THOUGHTS.map((thought) => (
                <OptionCard
                  key={thought.id}
                  label={thought.label}
                  width="w500"
                  onClick={() => chooseThought(thought.id)}
                />
              ))}
            </div>
            <button type="button" className="shop-button shop-button--ghost" onClick={back}>
              Back
            </button>
          </>
        )}

        {step === "request" && (
          <>
            <h1 className="title title--h4">
              {requestKind === "know" ? "I know what I want" : "Suggest changes"}
            </h1>
            <p className="edit__intro">Tell us in your own words, or pick one of the prompts below.</p>
            <div className="edit__request">
              <textarea
                className="edit__input"
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="e.g. A softer fabric with a straighter cut"
                rows={4}
              />
              <div className="edit__chips">
                {PRESETS.map((preset) => (
                  <button key={preset} type="button" className="shop__chip" onClick={() => setText(preset)}>
                    {preset}
                  </button>
                ))}
              </div>
              {listening && (
                <VoiceCapture
                  onDone={(spoken) => {
                    setText(spoken);
                    setListening(false);
                  }}
                />
              )}
              <div className="shop__actions">
                <button type="button" className="shop-button" onClick={() => setStep(3)}>
                  Find a replacement
                </button>
                <button
                  type="button"
                  className="shop-button shop-button--ghost"
                  onClick={() => setListening((current) => !current)}
                >
                  {listening ? "Stop listening" : "Use voice"}
                </button>
                <button type="button" className="shop-button shop-button--ghost" onClick={back}>
                  Back
                </button>
              </div>
            </div>
          </>
        )}

        {step === 3 && replacement && (
          <>
            <h1 className="title title--h4">A new {SINGULAR[category] || "piece"}</h1>
            <p className="edit__intro">
              {mode === "request" ? "This is a placeholder based on what you asked for." : "This is a placeholder replacement for the piece in your look."}
            </p>
            <ProductCard product={replacement} wide />
            {text && <p className="edit__note">Your request: “{text}”</p>}
            <p className="edit__note">
              Replacement pieces are placeholders until the store catalogue is connected. Nothing is sent to a shop yet.
            </p>
            <div className="shop__actions">
              <button type="button" className="shop-button" onClick={pick}>
                Pick options
              </button>
              <button type="button" className="shop-button shop-button--ghost" onClick={() => setVariant((current) => current + 1)}>
                Find something different
              </button>
              <button type="button" className="shop-button shop-button--ghost" onClick={back}>
                Back
              </button>
            </div>
          </>
        )}
      </main>
      <Toast toast={toast} />
    </div>
  );
}
