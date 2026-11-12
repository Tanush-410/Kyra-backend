import "./Dialog.css";

/**
 * A question over the screen: "Discard item?", "Exit?", "Still here?". Figma: "Bracelet Info card"
 * (2043:13577, in "Saved outfits" 2043:13563). What is behind it is blurred.
 *
 * The screen must also mark its own content inert while this is open (<div inert="">), so a pinch
 * can't press anything behind the dialog (HandTrackingContext skips [inert]).
 *
 * actions: [{ label, onClick }], top to bottom. Without a title it is just the stack of buttons
 * (Figma "Customize": Edit Outfit / Virtual try-on / More like this).
 * top: where the card starts (px from the top of the screen; 757 by default).
 */
export default function Dialog({ title, children, actions = [], label, top }) {
  return (
    <div className="dialog" role="dialog" aria-modal="true" aria-label={label || title} style={top != null ? { paddingTop: top } : undefined}>
      <div className={`dialog__card${title || children ? "" : " dialog__card--bare"}`}>
        {(title || children) && (
          <div className="dialog__body">
            {title && <h2 className="dialog__title">{title}</h2>}
            {children && <div className="dialog__text">{children}</div>}
          </div>
        )}
        <div className="dialog__actions">
          {actions.map((action) => (
            <button key={action.label} type="button" className="dialog__button" onClick={action.onClick} disabled={action.disabled}>
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
