import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import Dialog from "../../components/Dialog.jsx";
import FigmaProductCard, { withLook } from "../../components/FigmaProductCard.jsx";
import OptionCard from "../../components/OptionCard.jsx";
import ShopHeader from "../../components/ShopHeader.jsx";
import Toast from "../../components/Toast.jsx";
import { useKyraSession } from "../../context/KyraSessionContext.jsx";
import { applyFilters, firstAvailableSize, productsForLook } from "../../data/shopPlaceholders.js";
import { useHandSwipe, usePinchDrop } from "../../hooks/useHandSwipe.js";
import { useProductPhotos } from "../../hooks/useProductPhotos.js";
import { useSessionGuard } from "../../hooks/useSessionGuard.js";
import { useToast } from "../../hooks/useToast.js";
import { EDIT_LOOK_PATH, FILTER_PATH, LOOK_PATH, RESULTS_PATH } from "../../lib/shopRoutes.js";
import { activeOption, DEFAULT_PRICE_RANGE, editsForLook, keyOf } from "../../state/sessionReducer.js";
import "./shop.css";
import "./figma-shop.css";

const icon = (name) => `${import.meta.env.BASE_URL}assets/icons/${name}`;
// Figma "Suggestion to buy" (design/export-2/frames/buy-card.png): the card's top at y 370, More options and
// Find something different at y 1960 and 2102.
const CARD_TOP = 370;
const BUTTONS_TOP = 1960;

/** The piece's place in the outfit (product ids end in it), or -1 for a piece swapped in by an edit. */
const itemIndex = (product) => (product.replacesProductId ? -1 : Number(String(product.id).split(":").pop()));

/**
 * Figma: "Suggestion to buy" — the pieces of the look one at a time, as product cards (shop demo only:
 * placeholder prices, sizes and stock). Swipe, the arrows or a hand swipe move between pieces. Tapping the
 * piece opens its menu (Add to cart first, for mouse and touch); pinch and drag it onto the cart to add it,
 * onto the bin to skip it. More options / Find something different open the edit flow for that piece.
 */
export default function ProductsScreen() {
  const navigate = useNavigate();
  const session = useSessionGuard();
  const { state, addToCart, clearFilters, tryOn } = useKyraSession();
  const { toast, showToast } = useToast();
  const photoRef = useRef(null);
  const [index, setIndex] = useState(0);
  const [picks, setPicks] = useState({}); // product id -> { qty, size }
  const [menu, setMenu] = useState(false);
  const [qtyOpen, setQtyOpen] = useState(false);
  const [sizeOpen, setSizeOpen] = useState(false);
  const [outOfStock, setOutOfStock] = useState(null);
  const [exitOpen, setExitOpen] = useState(false);

  const look = activeOption(session);
  const round = session?.active?.round ?? session?.currentRound ?? 0;
  const option = look ? { ...look, round } : null;
  const lookKey = option ? keyOf(round, option.option) : null;
  const photoFor = useProductPhotos(option);
  const products = option ? applyFilters(productsForLook(option, lookKey, editsForLook(state.shop, lookKey)), state.shop.filters) : [];
  const at = Math.min(index, Math.max(0, products.length - 1));
  const base = products[at];
  const product = base ? withLook(base, option, itemIndex(base) >= 0 ? photoFor(itemIndex(base)) : null) : null;
  const pick = product ? { qty: 1, size: firstAvailableSize(product), ...picks[product.id] } : null;
  const isFiltered = state.shop.filters.from !== DEFAULT_PRICE_RANGE.from || state.shop.filters.to !== DEFAULT_PRICE_RANGE.to;
  const modalOpen = menu || qtyOpen || sizeOpen || Boolean(outOfStock) || exitOpen;

  const move = (by) => setIndex((i) => Math.min(products.length - 1, Math.max(0, i + by)));
  const choose = (patch) => setPicks((all) => ({ ...all, [product.id]: { ...pick, ...patch } }));
  const add = () => {
    setMenu(false);
    if (!product) return;
    if (!product.stock) {
      setOutOfStock(product);
      return;
    }
    addToCart(product, { size: pick.size, qty: pick.qty });
    showToast("Outfit added to cart");
  };
  const edit = (intent) =>
    navigate(EDIT_LOOK_PATH, { state: { round, option: option.option, piece: product.category === "outerwear" ? "top" : product.category, ...(intent ? { intent } : {}) } });

  useHandSwipe((direction) => !modalOpen && move(direction === "right" ? 1 : -1));
  usePinchDrop(photoRef, (target) => {
    if (target === "cart") add();
    else if (target === "bin") {
      showToast("Item discarded");
      move(1);
    }
  });

  if (!session) return <div className="screen" />;

  return (
    <div className="screen">
      <ShopHeader onExit={() => setExitOpen(true)} />
      <main className="shop-figma" inert={modalOpen ? "" : undefined}>
        {!product ? (
          <div className="shop__empty" style={{ position: "absolute", top: 900, left: 113, width: 850 }}>
            <p>No matches found.</p>
            <p>No pieces in this look match that price range.</p>
            <div className="fpc-buttons" style={{ position: "static", alignItems: "center" }}>
              <OptionCard label="Edit filters" width="w840" onClick={() => navigate(FILTER_PATH)} />
              {isFiltered && <OptionCard label="Clear filters" width="w840" onClick={clearFilters} />}
            </div>
          </div>
        ) : (
          <>
            {at > 0 && <span className="fpc-shade fpc-shade--left" style={{ top: CARD_TOP + 330 }} aria-hidden="true" />}
            {at < products.length - 1 && <span className="fpc-shade fpc-shade--right" style={{ top: CARD_TOP + 330 }} aria-hidden="true" />}
            <div style={{ position: "absolute", top: CARD_TOP, left: 0, width: 1080 }}>
              <FigmaProductCard
                product={product}
                qty={pick.qty}
                size={pick.size}
                photoRef={photoRef}
                onPhoto={() => setMenu(true)}
                onQty={() => setQtyOpen(true)}
                onSize={() => setSizeOpen(true)}
              />
            </div>
            <button type="button" className="fpc-arrow fpc-arrow--left" style={{ top: CARD_TOP + 268 }} aria-label="Previous piece" onClick={() => move(-1)} disabled={at === 0}>
              <img src={icon("arrow-left.svg")} alt="" width="74" height="74" />
            </button>
            <button type="button" className="fpc-arrow fpc-arrow--right" style={{ top: CARD_TOP + 268 }} aria-label="Next piece" onClick={() => move(1)} disabled={at >= products.length - 1}>
              <img src={icon("arrow-right.svg")} alt="" width="74" height="74" />
            </button>
            <p className="fpc-note" style={{ top: CARD_TOP + 1350 }}>
              {at + 1} of {products.length} · Prices, sizes and stock are placeholders
            </p>
            <div className="fpc-buttons" style={{ top: BUTTONS_TOP }}>
              <OptionCard label="More options" width="w840" onClick={() => edit()} />
              <OptionCard label="Find something different" width="w840" onClick={() => edit("different")} />
            </div>
          </>
        )}
      </main>
      <Toast toast={toast} />

      {menu && product && (
        <Dialog
          label={`${product.name}: options`}
          top={860}
          actions={[
            { label: "Add to cart", onClick: add },
            { label: "Edit outfit", onClick: () => navigate(EDIT_LOOK_PATH, { state: { round, option: option.option } }) },
            {
              label: "Virtual try-on",
              onClick: async () => {
                setMenu(false);
                await tryOn(round, option.option);
                navigate(LOOK_PATH);
              },
            },
            { label: "Back", onClick: () => setMenu(false) },
          ]}
        />
      )}
      {qtyOpen && product && (
        <Dialog
          title="Quantity"
          actions={[
            ...Array.from({ length: Math.max(1, Math.min(5, product.stock || 1)) }, (_, i) => ({
              label: String(i + 1),
              onClick: () => {
                choose({ qty: i + 1 });
                setQtyOpen(false);
              },
            })),
          ]}
        />
      )}
      {sizeOpen && product && (
        <Dialog
          title="Size"
          actions={product.sizes.map((size) => {
            const unavailable = (product.outOfStockSizes || []).includes(size);
            return {
              label: unavailable ? `${size} · Out of stock` : size,
              disabled: unavailable,
              onClick: () => {
                choose({ size });
                setSizeOpen(false);
              },
            };
          })}
        />
      )}
      {outOfStock && (
        <Dialog
          title="Out of stock"
          actions={[
            { label: "Find something else", onClick: () => { setOutOfStock(null); edit("different"); } },
            { label: "Continue shopping", onClick: () => setOutOfStock(null) },
          ]}
        >
          <p>We are sorry to inform that the item is out of stock</p>
        </Dialog>
      )}
      {exitOpen && (
        <Dialog
          title="Exit"
          actions={[
            { label: "Continue shopping", onClick: () => setExitOpen(false) },
            { label: "Exit", onClick: () => navigate(RESULTS_PATH) },
          ]}
        >
          <p>Are you sure you want to exit?</p>
        </Dialog>
      )}
    </div>
  );
}
