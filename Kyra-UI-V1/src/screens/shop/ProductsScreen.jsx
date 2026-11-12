import { useState } from "react";
import { useNavigate } from "react-router-dom";
import Dialog from "../../components/Dialog.jsx";
import ProductCard from "../../components/ProductCard.jsx";
import ShopHeader from "../../components/ShopHeader.jsx";
import Toast from "../../components/Toast.jsx";
import { useKyraSession } from "../../context/KyraSessionContext.jsx";
import {
  applyFilters,
  firstAvailableSize,
  formatPrice,
  productsForLook,
} from "../../data/shopPlaceholders.js";
import { useSessionGuard } from "../../hooks/useSessionGuard.js";
import { useToast } from "../../hooks/useToast.js";
import { EDIT_PATH, FILTER_PATH, RESULTS_PATH } from "../../lib/shopRoutes.js";
import { activeOption, DEFAULT_PRICE_RANGE, editsForLook, keyOf } from "../../state/sessionReducer.js";
import "./shop.css";

/** Figma: "Suggestion to buy" — the pieces in the look, with prices and an Add to cart action. */
export default function ProductsScreen() {
  const navigate = useNavigate();
  const session = useSessionGuard();
  const { state, addToCart, clearFilters } = useKyraSession();
  const { toast, showToast } = useToast();
  const [outOfStock, setOutOfStock] = useState(null);
  const [exitOpen, setExitOpen] = useState(false);

  const option = activeOption(session);
  const round = session?.active?.round ?? session?.currentRound ?? 0;
  const lookKey = option ? keyOf(round, option.option) : null;
  const products = option ? productsForLook(option, lookKey, editsForLook(state.shop, lookKey)) : [];
  const filtered = applyFilters(products, state.shop.filters);
  const isFiltered =
    state.shop.filters.from !== DEFAULT_PRICE_RANGE.from || state.shop.filters.to !== DEFAULT_PRICE_RANGE.to;
  const modalOpen = Boolean(outOfStock) || exitOpen;

  const add = (product) => {
    if (!product.stock) {
      setOutOfStock(product);
      return;
    }
    addToCart(product, { size: firstAvailableSize(product), qty: 1 });
    showToast("Added to cart");
  };

  if (!session) return <div className="screen" />;

  return (
    <div className="screen">
      <ShopHeader onExit={() => setExitOpen(true)} />
      <main className="screen__content shop" inert={modalOpen ? "" : undefined}>
        <h1 className="title title--h4">Shop this look</h1>
        <p className="shop__lede">
          Pieces from your look. Prices, sizes and stock are placeholders until the store catalogue is connected.
        </p>
        <div className="shop__toolbar">
          <button type="button" className="shop__chip" onClick={() => navigate(EDIT_PATH)}>
            Edit this look
          </button>
          {isFiltered && (
            <>
              <button type="button" className="shop__chip" onClick={() => navigate(FILTER_PATH)}>
                Filter: {formatPrice(state.shop.filters.from)} – {formatPrice(state.shop.filters.to)}
              </button>
              <button type="button" className="shop__chip" onClick={clearFilters}>
                Clear filters
              </button>
            </>
          )}
        </div>

        {filtered.length === 0 ? (
          <div className="shop__empty">
            <p>No matches found.</p>
            <p>No pieces in this look match that price range.</p>
            <div className="shop__actions">
              <button type="button" className="shop-button" onClick={() => navigate(FILTER_PATH)}>
                Edit filters
              </button>
              <button type="button" className="shop-button shop-button--ghost" onClick={clearFilters}>
                Clear filters
              </button>
            </div>
          </div>
        ) : (
          <div className="shop-grid">
            {filtered.map((product) => (
              <ProductCard
                key={product.id}
                product={product}
                onAdd={add}
                onEdit={(piece) => navigate(`${EDIT_PATH}?category=${piece.category}`)}
              />
            ))}
          </div>
        )}
      </main>
      <Toast toast={toast} />

      {outOfStock && (
        <Dialog
          title="Out of stock"
          actions={[
            { label: "Find something else", onClick: () => { setOutOfStock(null); navigate(EDIT_PATH); } },
            { label: "Continue shopping", onClick: () => setOutOfStock(null) },
          ]}
        >
          {outOfStock.name} is out of stock right now. We can help you find an alternative.
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
