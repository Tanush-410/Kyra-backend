import "./AppHeader.css";

function CartIcon() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <path d="M8 12h7l7 30h28l6-21H20" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="27" cy="51" r="4.5" fill="currentColor" />
      <circle cx="45" cy="51" r="4.5" fill="currentColor" />
    </svg>
  );
}

function FilterIcon() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <path d="M8 16h48M8 32h48M8 48h48" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" />
      <circle cx="22" cy="16" r="7" fill="currentColor" />
      <circle cx="43" cy="32" r="7" fill="currentColor" />
      <circle cx="28" cy="48" r="7" fill="currentColor" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <path d="M12 18h40M26 18v-6h12v6M20 18l3 34h18l3-34M28 27v17M36 27v17" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Top bar: Kyra star (left); optional cart, filter and exit icons plus the profile icon (right).
 * Figma: "Frame 1410126071". Every icon is a real button so pinch clicks work.
 */
export default function AppHeader({
  onKyraClick,
  onProfileClick,
  onCartClick,
  onFilterClick,
  onExitClick,
  cartCount = 0,
  paddingX = 18,
}) {
  return (
    <header className="app-header" style={{ paddingInline: paddingX }}>
      <button type="button" className="app-header__kyra" onClick={onKyraClick} aria-label="Kyra">
        <img src={`${import.meta.env.BASE_URL}assets/icons/kyra-star.png`} alt="" />
      </button>
      <div className="app-header__actions">
        {onCartClick && (
          <button type="button" className="app-header__icon app-header__icon--cart" onClick={onCartClick} aria-label={`Cart${cartCount ? `, ${cartCount} items` : ""}`}>
            <CartIcon />
            {cartCount > 0 && <span className="app-header__badge">{cartCount}</span>}
          </button>
        )}
        {onFilterClick && (
          <button type="button" className="app-header__icon app-header__icon--filter" onClick={onFilterClick} aria-label="Filter">
            <FilterIcon />
          </button>
        )}
        {onExitClick && (
          <button type="button" className="app-header__icon app-header__icon--exit" onClick={onExitClick} aria-label="Exit">
            <TrashIcon />
          </button>
        )}
        <button type="button" className="app-header__profile" onClick={onProfileClick} aria-label="Account">
          <img src={`${import.meta.env.BASE_URL}assets/icons/user-profile.png`} alt="" />
        </button>
      </div>
    </header>
  );
}
