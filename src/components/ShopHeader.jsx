import { useNavigate } from "react-router-dom";
import { useKyraSession } from "../context/KyraSessionContext.jsx";
import { ACCOUNT_PATH, CART_PATH, FILTER_PATH, RESULTS_PATH } from "../lib/shopRoutes.js";
import { cartCount } from "../state/sessionReducer.js";
import AppHeader from "./AppHeader.jsx";

/**
 * The shop's top bar: the Figma header (AppHeader) wired to the kiosk routes. Bin = exit (onExit),
 * cart and filter go to their screens, profile to the account screen. The cart shows how many items
 * it holds and shakes when that changes.
 */
export default function ShopHeader({ onExit, onCart, onFilter, showCart = true, showFilter = true }) {
  const navigate = useNavigate();
  const { state } = useKyraSession();
  const count = cartCount(state.shop);
  return (
    <AppHeader
      onKyraClick={() => navigate("/")}
      onProfileClick={() => navigate(ACCOUNT_PATH)}
      onBin={onExit || (() => navigate(RESULTS_PATH))}
      onCart={showCart ? onCart || (() => navigate(CART_PATH)) : undefined}
      onFilter={showFilter ? onFilter || (() => navigate(FILTER_PATH)) : undefined}
      cartCount={count}
      cartPulse={count}
    />
  );
}
