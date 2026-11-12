/**
 * Figma: "Bracelet Info card".
 * width: "default" (600) | "w500" (500) | "w840" (840, the full-width buttons) | "auto" (hugs content)
 * disabled: greyed out; neither a click nor a pinch does anything
 */
export default function OptionCard({ label, icon, iconWidth = 200, width = "default", onClick, disabled = false }) {
  const cls = [
    "option-card",
    width === "w500" && "option-card--w500",
    width === "w840" && "option-card--w840",
    width === "auto" && "option-card--auto",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button type="button" className={cls} onClick={onClick} disabled={disabled}>
      {icon && (
        <img
          className="option-card__icon"
          src={icon}
          alt=""
          style={{ width: iconWidth }}
        />
      )}
      <span>{label}</span>
    </button>
  );
}
