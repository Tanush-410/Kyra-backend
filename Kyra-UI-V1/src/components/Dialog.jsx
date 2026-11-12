import OptionCard from "./OptionCard.jsx";
import "./Dialog.css";

/**
 * A modal that sits inside the 1080px screen. The parent marks the rest of the screen `inert`, so
 * the only pinch targets are these real buttons.
 */
export default function Dialog({ title, children, actions = [], label }) {
  return (
    <div className="dialog" role="dialog" aria-modal="true" aria-label={label || title || "Dialog"}>
      <div className="dialog__card">
        {title && <h2 className="dialog__title">{title}</h2>}
        {children && <div className="dialog__body">{children}</div>}
        {actions.length > 0 && (
          <div className="dialog__actions">
            {actions.map((action) => (
              <OptionCard
                key={action.label}
                label={action.label}
                width="auto"
                onClick={action.onClick}
                disabled={action.disabled}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
