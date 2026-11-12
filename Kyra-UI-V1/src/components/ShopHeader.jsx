import { useNavigate } from "react-router-dom";
import { useKyraSession } from "../context/KyraSessionContext.jsx";
import { ACCOUNT_PATH, CART_PATH, FILTER_PATH, RESULTS_PATH } from "../lib/shopRoutes.js";
import { cartCount } from "../state/sessionReducer.js";
import AppHeader from "./AppHeader.jsx";

/** The shop's top bar: the five entry points from the Figma header, wired to the kiosk routes. */
export default function ShopHeader({ onExit, onCart, onFilter, showCart = true, showFilter = true }) {
  const navigate = useNavigate();
  const { state } = useKyraSession();
  return (
    <AppHeader
      onKyraClick={() => navigate("/")}
      onProfileClick={() => navigate(ACCOUNT_PATH)}
      onCartClick={showCart ? onCart || (() => navigate(CART_PATH)) : undefined}
      onFilterClick={showFilter ? onFilter || (() => navigate(FILTER_PATH)) : undefined}
      onExitClick={onExit || (() => navigate(RESULTS_PATH))}
      cartCount={cartCount(state.shop)}
    />
  );
}
