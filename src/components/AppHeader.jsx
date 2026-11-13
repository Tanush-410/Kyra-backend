import { useRef } from "react";
import { usePinchHold } from "../hooks/useHandSwipe.js";
import "./AppHeader.css";

const icon = (name) => `${import.meta.env.BASE_URL}assets/icons/${name}`;

/**
 * Top bar. Figma: "Frame 1410126071" (2043:13424).
 *
 * Onboarding screens show only the Kyra star (left) and the profile icon (right). Screens after the
 * analysis add the round tools under them: bin (end the visit) on the left, cart and filter on the right.
 * Each tool appears only when its handler is passed, so a screen shows just what works there.
 *
 * cartPulse: the cart shakes once to show something was just added to it (Figma note: "the cart icon
 * starts vibrating to catch attention"). Change the value (a counter) to shake it again.
 * cartCount: a badge with the number of items in the cart (hidden at 0).
 * onBinHold: a pinch held on the bin for 1.5 s (a ring fills) ends the visit with no dialog: the hold is
 *   the confirmation. A click (mouse, or a pinch elsewhere) still calls onBin.
 * The bin and the cart are also drop targets for the shop demo's pinch and drag (data-drop).
 */
export default function AppHeader({
  onKyraClick,
  onProfileClick,
  onBin,
  onCart,
  onFilter,
  onBinHold,
  cartPulse = 0,
  cartCount = 0,
  paddingX = 18,
}) {
  const tools = Boolean(onBin || onCart || onFilter);
  const binRef = useRef(null);
  usePinchHold(binRef, onBinHold);
  return (
    <header className={`app-header${tools ? " app-header--tools" : ""}`} style={{ paddingInline: paddingX }}>
      <div className="app-header__row app-header__row--top">
        <button type="button" className="app-header__kyra" onClick={onKyraClick} aria-label="Kyra">
          <img src={icon("kyra-star.png")} alt="" />
        </button>
        <button type="button" className="app-header__profile" onClick={onProfileClick} aria-label="Profile">
          <img src={icon("user-profile.png")} alt="" />
        </button>
      </div>
      {(onBin || onCart) && (
        <div className="app-header__row app-header__row--tools">
          {onBin && (
            <button
              ref={binRef}
              type="button"
              className="app-header__tool"
              onClick={onBin}
              aria-label="End my visit"
              data-drop="bin"
              data-pinch-hold={onBinHold ? "" : undefined}
            >
              <img src={icon("header-bin.svg")} alt="" width="156.6" height="156.6" />
            </button>
          )}
          {onCart && (
            <button
              type="button"
              key={cartPulse}
              className={`app-header__tool app-header__tool--end${cartPulse ? " app-header__tool--pulse" : ""}`}
              onClick={onCart}
              aria-label={cartCount ? `Cart, ${cartCount} items` : "Cart"}
              data-drop="cart"
            >
              <img src={icon("header-cart.svg")} alt="" width="156.6" height="156.6" />
              {cartCount > 0 && <span className="app-header__badge">{cartCount}</span>}
            </button>
          )}
        </div>
      )}
      {onFilter && (
        <div className="app-header__row app-header__row--tools">
          <button type="button" className="app-header__tool app-header__tool--end" onClick={onFilter} aria-label="Filters">
            <img src={icon("header-filter.svg")} alt="" width="156.6" height="156.6" />
          </button>
        </div>
      )}
    </header>
  );
}
