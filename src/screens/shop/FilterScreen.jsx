import { useState } from "react";
import { useNavigate } from "react-router-dom";
import Dialog from "../../components/Dialog.jsx";
import ShopHeader from "../../components/ShopHeader.jsx";
import Toast from "../../components/Toast.jsx";
import { useKyraSession } from "../../context/KyraSessionContext.jsx";
import { applyFilters, formatPrice, productsForLook } from "../../data/shopPlaceholders.js";
import { useSessionGuard } from "../../hooks/useSessionGuard.js";
import { useToast } from "../../hooks/useToast.js";
import { SHOP_PATH } from "../../lib/shopRoutes.js";
import { activeOption, DEFAULT_PRICE_RANGE, editsForLook, keyOf } from "../../state/sessionReducer.js";
import "./shop.css";

const MAX_PRICE = DEFAULT_PRICE_RANGE.to;
const STEP = 100;

/** Figma: "Filter" — price range with From/To boxes, plus the "No matches found" dialog. */
export default function FilterScreen() {
  const navigate = useNavigate();
  const session = useSessionGuard();
  const { state, setFilters, clearFilters } = useKyraSession();
  const { toast, showToast } = useToast();
  const [from, setFrom] = useState(state.shop.filters.from);
  const [to, setTo] = useState(state.shop.filters.to);
  const [noMatches, setNoMatches] = useState(false);

  const option = activeOption(session);
  const round = session?.active?.round ?? session?.currentRound ?? 0;
  const lookKey = option ? keyOf(round, option.option) : null;
  const products = option ? productsForLook(option, lookKey, editsForLook(state.shop, lookKey)) : [];
  const modalOpen = noMatches;

  const changeFrom = (value) => {
    const next = Math.max(0, Math.min(Number(value) || 0, to));
    setFrom(next);
  };
  const changeTo = (value) => {
    const next = Math.max(from, Math.min(Number(value) || 0, MAX_PRICE));
    setTo(next);
  };
  const nudgeFrom = (amount) => changeFrom(from + amount);
  const nudgeTo = (amount) => changeTo(to + amount);

  const apply = () => {
    setFilters({ from, to });
    const matches = applyFilters(products, { from, to });
    if (matches.length === 0) {
      setNoMatches(true);
      return;
    }
    showToast("Filters applied");
    navigate(SHOP_PATH);
  };

  const clear = () => {
    clearFilters();
    setFrom(DEFAULT_PRICE_RANGE.from);
    setTo(DEFAULT_PRICE_RANGE.to);
    setNoMatches(false);
    showToast("Filters cleared");
    navigate(SHOP_PATH);
  };

  if (!session) return <div className="screen" />;

  return (
    <div className="screen">
      <ShopHeader />
      <main className="screen__content shop" inert={modalOpen ? "" : undefined}>
        <h1 className="title title--h4">Filter</h1>
        <p className="shop__lede">Set a price range. Every piece in your look stays available unless it falls outside it.</p>

        <div className="filter">
          <div className="filter__row">
            <span className="filter__label">From</span>
            <button type="button" className="filter__step" onClick={() => nudgeFrom(-STEP)} aria-label="Lower minimum price">
              −
            </button>
            <input
              className="filter__range"
              type="range"
              min="0"
              max={MAX_PRICE}
              step={STEP}
              value={from}
              onChange={(event) => changeFrom(event.target.value)}
              aria-label="Minimum price"
            />
            <button type="button" className="filter__step" onClick={() => nudgeFrom(STEP)} aria-label="Raise minimum price">
              +
            </button>
            <output className="filter__value">{formatPrice(from)}</output>
          </div>

          <div className="filter__row">
            <span className="filter__label">To</span>
            <button type="button" className="filter__step" onClick={() => nudgeTo(-STEP)} aria-label="Lower maximum price">
              −
            </button>
            <input
              className="filter__range"
              type="range"
              min="0"
              max={MAX_PRICE}
              step={STEP}
              value={to}
              onChange={(event) => changeTo(event.target.value)}
              aria-label="Maximum price"
            />
            <button type="button" className="filter__step" onClick={() => nudgeTo(STEP)} aria-label="Raise maximum price">
              +
            </button>
            <output className="filter__value">{formatPrice(to)}</output>
          </div>

          <p className="filter__hint">Use the − and + buttons if you're shopping by hand gesture.</p>

          <div className="shop__actions">
            <button type="button" className="shop-button" onClick={apply}>
              Apply
            </button>
            <button type="button" className="shop-button shop-button--ghost" onClick={clear}>
              Clear Filters
            </button>
          </div>
        </div>
      </main>
      <Toast toast={toast} />

      {noMatches && (
        <Dialog
          title="No matches found"
          actions={[
            { label: "Edit Filters", onClick: () => setNoMatches(false) },
            { label: "Clear Filters", onClick: clear },
          ]}
        >
          No pieces match {formatPrice(from)} – {formatPrice(to)}. Try a wider range.
        </Dialog>
      )}
    </div>
  );
}
