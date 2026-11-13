import { useNavigate } from "react-router-dom";
import { SHOP_DEMO } from "../config.js";
import { useKyraSession } from "../context/KyraSessionContext.jsx";
import { CART_PATH } from "../lib/shopRoutes.js";
import { cartCount } from "../state/sessionReducer.js";

/**
 * The cart button for AppHeader, on every screen from the photo onwards (Skin Tone, Fit, Suggestions, the
 * look, Edit, Rate and changes, Your results): { onCart, cartCount, cartPulse }, spread into <AppHeader>.
 * Empty when the shop is switched off (VITE_SHOP_DEMO=false).
 */
export function useCartTool() {
  const navigate = useNavigate();
  const { state } = useKyraSession();
  if (!SHOP_DEMO) return {};
  const count = cartCount(state.shop);
  return { onCart: () => navigate(CART_PATH), cartCount: count, cartPulse: count };
}
