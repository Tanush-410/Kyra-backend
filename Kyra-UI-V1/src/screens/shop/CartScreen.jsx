import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import Dialog from "../../components/Dialog.jsx";
import ProductCard from "../../components/ProductCard.jsx";
import ShopHeader from "../../components/ShopHeader.jsx";
import Toast from "../../components/Toast.jsx";
import { useKyraSession } from "../../context/KyraSessionContext.jsx";
import { formatPrice } from "../../data/shopPlaceholders.js";
import { useSessionGuard } from "../../hooks/useSessionGuard.js";
import { useToast } from "../../hooks/useToast.js";
import { CART_PATH, CHECKOUT_PATH, EDIT_PATH, RESULTS_PATH, SHOP_PATH } from "../../lib/shopRoutes.js";
import { cartSubtotal } from "../../state/sessionReducer.js";
import "./shop.css";

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
  const dragStart = useRef(null);

  useEffect(() => {
    setIndex((current) => Math.min(current, Math.max(0, items.length - 1)));
  }, [items.length]);

  const current = items[Math.min(index, Math.max(0, items.length - 1))];
  const itemOutOfStock = Boolean(current && (!current.stock || current.stock < 1));
  const modalOpen = Boolean(qtyOpen || sizeOpen || sizeOutOfStock || discardOpen || exitOpen || itemOutOfStock);

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
      <main className="screen__content shop" inert={modalOpen ? "" : undefined}>
        <h1 className="title title--h4">Cart</h1>

        {!current ? (
          <div className="shop__empty">
            <p>Your cart is empty.</p>
            <button type="button" className="shop-button" onClick={() => navigate(SHOP_PATH)}>
              Continue shopping
            </button>
          </div>
        ) : (
          <>
            <div className="cart-count">
              Item {Math.min(index + 1, items.length)} of {items.length}
            </div>
            <div className="cart-stage">
              <button
                type="button"
                className="cart-arrow"
                onClick={() => move(-1)}
                disabled={index <= 0}
                aria-label="Previous item"
              >
                ‹
              </button>
              <div className="cart-swipe" onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerCancel={() => (dragStart.current = null)}>
                <ProductCard product={current} wide />
              </div>
              <button
                type="button"
                className="cart-arrow"
                onClick={() => move(1)}
                disabled={index >= items.length - 1}
                aria-label="Next item"
              >
                ›
              </button>
            </div>

            <div className="cart-controls">
              <button type="button" className="shop-select" onClick={() => setQtyOpen(true)}>
                Quantity: {current.qty} ▾
              </button>
              <button type="button" className="shop-select" onClick={() => setSizeOpen(true)}>
                Size: {current.size || "Select"} ▾
              </button>
              <button type="button" className="shop-select" onClick={() => setDiscardOpen(true)}>
                Remove item
              </button>
            </div>

            <div className="cart-controls">
              <span className="cart-total">Total {formatPrice(cartSubtotal(state.shop))}</span>
            </div>

            <div className="shop__actions">
              <button type="button" className="shop-button" onClick={() => navigate(SHOP_PATH)}>
                Continue Shopping
              </button>
              <button type="button" className="shop-button" onClick={() => navigate(CHECKOUT_PATH)}>
                Checkout
              </button>
            </div>
          </>
        )}
      </main>
      <Toast toast={toast} />

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
          {sizeOutOfStock} is out of stock for {current.name}.
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
          {current.name} is out of stock right now.
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
          Remove {current.name} from your cart?
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
          Leave the shop and go back to your look?
        </Dialog>
      )}
    </div>
  );
}
