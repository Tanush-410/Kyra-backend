import { useNavigate } from "react-router-dom";
import { SHOP_DEMO } from "../config.js";
import { useKyraSession } from "../context/KyraSessionContext.jsx";
import { ACCOUNT_PATH, CART_PATH, FILTER_PATH, RESULTS_PATH } from "../lib/shopRoutes.js";
import { cartCount } from "../state/sessionReducer.js";
import AppHeader from "./AppHeader.jsx";

/**
 * The shop's top bar: the Figma header (AppHeader) wired to the kiosk routes. Bin = exit (onExit),
 * cart and filter go to their screens, profile to the account screen. The cart shows how many items
 * it holds and shakes when that changes. Cart and filter appear while the shop is on (VITE_SHOP_DEMO, on unless "false").
 * onExitHold: a pinch held on the bin (no dialog: the hold is the confirmation).
 */
export default function ShopHeader({ onExit, onExitHold, onCart, onFilter, showCart = SHOP_DEMO, showFilter = SHOP_DEMO }) {
  const navigate = useNavigate();
  const { state } = useKyraSession();
  const count = cartCount(state.shop);
  return (
    <AppHeader
      onKyraClick={() => navigate("/")}
      onProfileClick={() => navigate(ACCOUNT_PATH)}
      onBin={onExit || (() => navigate(RESULTS_PATH))}
      onBinHold={onExitHold}
      onCart={SHOP_DEMO && showCart ? onCart || (() => navigate(CART_PATH)) : undefined}
      onFilter={SHOP_DEMO && showFilter ? onFilter || (() => navigate(FILTER_PATH)) : undefined}
      cartCount={count}
      cartPulse={count}
    />
  );
}
