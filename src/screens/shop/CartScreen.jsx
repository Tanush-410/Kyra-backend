import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import Dialog from "../../components/Dialog.jsx";
import FigmaProductCard from "../../components/FigmaProductCard.jsx";
import { usePinchDrop } from "../../hooks/useHandSwipe.js";
import ShopHeader from "../../components/ShopHeader.jsx";
import Toast from "../../components/Toast.jsx";
import { useKyraSession } from "../../context/KyraSessionContext.jsx";
import { formatPrice } from "../../data/shopPlaceholders.js";
import { useSessionGuard } from "../../hooks/useSessionGuard.js";
import { useToast } from "../../hooks/useToast.js";
import { CART_PATH, CHECKOUT_PATH, EDIT_PATH, RESULTS_PATH, SHOP_PATH } from "../../lib/shopRoutes.js";
import { cartSubtotal } from "../../state/sessionReducer.js";
import OptionCard from "../../components/OptionCard.jsx";
import "./shop.css";
import "./figma-shop.css";

/** Figma: "Cart" — one product at a time, drop-downs, four dialogs, and a swipeable carousel. */
export default function CartScreen() {
  const navigate = useNavigate();
  const session = useSessionGuard();
  const { state, removeFromCart, setCartQty, setCartSize } = useKyraSession();
  const { toast, showToast } = useToast();
  const items = state.shop.cart;
  const [index, setIndex] = useState(0);
  const [qtyOpen, setQtyOpen] = useState(false);
  const [sizeOpen, setSizeOpen] = useState(false);
  const [sizeOutOfStock, setSizeOutOfStock] = useState(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [exitOpen, setExitOpen] = useState(false);
  const [itemMenu, setItemMenu] = useState(false);
  const dragStart = useRef(null);
  const photoRef = useRef(null);
  // Figma: pinch and drag the item onto the bin to discard it (the Discard Item question follows).
  usePinchDrop(photoRef, (target) => target === "bin" && setDiscardOpen(true));

  useEffect(() => {
    setIndex((current) => Math.min(current, Math.max(0, items.length - 1)));
  }, [items.length]);

  const current = items[Math.min(index, Math.max(0, items.length - 1))];
  const itemOutOfStock = Boolean(current && (!current.stock || current.stock < 1));
  const modalOpen = Boolean(qtyOpen || sizeOpen || sizeOutOfStock || discardOpen || exitOpen || itemOutOfStock || itemMenu);

  const move = (direction) => {
    setIndex((currentIndex) => Math.min(items.length - 1, Math.max(0, currentIndex + direction)));
  };

  const onPointerDown = (event) => {
    dragStart.current = event.clientX;
  };
  const onPointerUp = (event) => {
    const start = dragStart.current;
    dragStart.current = null;
    if (start == null) return;
    const delta = event.clientX - start;
    if (Math.abs(delta) > 60) move(delta < 0 ? 1 : -1);
  };

  const remove = () => {
    if (!current) return;
    removeFromCart(current.id);
    setDiscardOpen(false);
    showToast("Item discarded");
  };

  if (!session) return <div className="screen" />;

  return (
    <div className="screen">
      <ShopHeader onExit={() => setExitOpen(true)} onCart={() => navigate(CART_PATH)} />
      {/* Figma "Cart" (2043:13494): no title; the product card at (87, 455), 905 wide. */}
      <main className="shop shop-figma cart-figma" inert={modalOpen ? "" : undefined}>

        {!current ? (
          <div className="shop__empty">
            <p>Your cart is empty.</p>
            <button type="button" className="shop-button" onClick={() => navigate(SHOP_PATH)}>
              Continue shopping
            </button>
          </div>
        ) : (
          <>
            {/* Figma "Cart" (design/export-2/frames/cart-card.png): the product card at y 470, side shades and
                arrows, Continue Shopping / Checkout at y 2022 and 2165. */}
            {index > 0 && <span className="fpc-shade fpc-shade--left" style={{ top: 791 }} aria-hidden="true" />}
            {index < items.length - 1 && <span className="fpc-shade fpc-shade--right" style={{ top: 791 }} aria-hidden="true" />}
            <div
              style={{ position: "absolute", top: 470, left: 0, width: 1080 }}
              onPointerDown={onPointerDown}
              onPointerUp={onPointerUp}
              onPointerCancel={() => (dragStart.current = null)}
            >
              <FigmaProductCard
                product={current}
                qty={current.qty}
                size={current.size}
                photoRef={photoRef}
                onPhoto={() => setItemMenu(true)}
                onQty={() => setQtyOpen(true)}
                onSize={() => setSizeOpen(true)}
              />
            </div>
            <button type="button" className="fpc-arrow fpc-arrow--left" style={{ top: 738 }} onClick={() => move(-1)} disabled={index <= 0} aria-label="Previous item">
              <img src={`${import.meta.env.BASE_URL}assets/icons/arrow-left.svg`} alt="" width="74" height="74" />
            </button>
            <button type="button" className="fpc-arrow fpc-arrow--right" style={{ top: 738 }} onClick={() => move(1)} disabled={index >= items.length - 1} aria-label="Next item">
              <img src={`${import.meta.env.BASE_URL}assets/icons/arrow-right.svg`} alt="" width="74" height="74" />
            </button>
            <p className="fpc-note" style={{ top: 1830 }}>
              {Math.min(index + 1, items.length)} of {items.length} · Total {formatPrice(cartSubtotal(state.shop))} · placeholder prices
            </p>
            <div className="fpc-buttons" style={{ top: 2022 }}>
              <OptionCard label="Continue Shopping" width="w840" onClick={() => navigate(SHOP_PATH)} />
              <OptionCard label="Checkout" width="w840" onClick={() => navigate(CHECKOUT_PATH)} />
            </div>
          </>
        )}
      </main>
      <Toast toast={toast} />

      {itemMenu && current && (
        <Dialog
          label={`${current.name}: options`}
          top={860}
          actions={[
            { label: "Remove from Cart", onClick: () => { setItemMenu(false); setDiscardOpen(true); } },
            { label: "Back", onClick: () => setItemMenu(false) },
          ]}
        />
      )}

      {qtyOpen && current && (
        <Dialog
          title="Quantity"
          actions={Array.from({ length: Math.max(1, current.stock) }, (_, i) => ({
            label: String(i + 1),
            onClick: () => {
              setCartQty(current.id, i + 1);
              setQtyOpen(false);
            },
          }))}
        >
          How many of {current.name}?
        </Dialog>
      )}

      {sizeOpen && current && (
        <Dialog
          title="Choose a size"
          actions={current.sizes.map((size) => {
            const unavailable = (current.outOfStockSizes || []).includes(size);
            return {
              label: unavailable ? `${size} · Out of stock` : size,
              onClick: () => {
                setSizeOpen(false);
                if (unavailable) setSizeOutOfStock(size);
                else setCartSize(current.id, size);
              },
            };
          })}
        >
          Size: {current.size}
        </Dialog>
      )}

      {sizeOutOfStock && current && (
        <Dialog
          title="Out of stock"
          actions={[
            { label: "Find something else", onClick: () => { setSizeOutOfStock(null); navigate(EDIT_PATH); } },
            {
              label: "Remove from Cart",
              onClick: () => {
                const id = current.id;
                setSizeOutOfStock(null);
                removeFromCart(id);
                showToast("Item discarded");
              },
            },
          ]}
        >
          We are sorry to inform that the size you are looking for is out of stock.
        </Dialog>
      )}

      {itemOutOfStock && current && (
        <Dialog
          title="Out of stock"
          actions={[
            { label: "Find something else", onClick: () => navigate(SHOP_PATH) },
            {
              label: "Remove from Cart",
              onClick: () => {
                const id = current.id;
                removeFromCart(id);
                showToast("Item discarded");
              },
            },
          ]}
        >
          We are sorry to inform that the item is out of stock.
        </Dialog>
      )}

      {discardOpen && current && (
        <Dialog
          title="Discard Item"
          actions={[
            { label: "Keep Item", onClick: () => setDiscardOpen(false) },
            { label: "Remove from Cart", onClick: remove },
          ]}
        >
          Are you sure you want to discard this item?
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
          Are you sure you want to exit?
        </Dialog>
      )}
    </div>
  );
}
