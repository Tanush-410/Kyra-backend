import AppHeader from "./AppHeader.jsx";
import OptionCard from "./OptionCard.jsx";
import "./EndScreen.css";

/**
 * The "End" screens (Figma 2043:13348): a title and a line, and for "Still here?" two buttons.
 * Bye (13349), Great / Perfect (13358, 13374), Still here? (13383). Positions are the frames'.
 * actions: [{ label, onClick }]; onTap: the whole screen is a button (to dismiss Great / Perfect).
 */
export default function EndScreen({ title, text, actions = [], onTap, live = false }) {
  // Tappable: role="button" (pinches press it too), not a <button>, which would centre the header.
  const tap = onTap ? { role: "button", tabIndex: 0, onClick: onTap, onKeyDown: (e) => (e.key === "Enter" || e.key === " ") && onTap() } : {};
  return (
    <div className={`screen end-screen${onTap ? " end-screen--tap" : ""}`} {...tap}>
      <AppHeader />
      <div className="end-screen__prompt" role={live ? "alert" : undefined}>
        <h1 className="title end-screen__title">{title}</h1>
        {text && <p className="screen__text end-screen__text">{text}</p>}
      </div>
      {actions.length > 0 && (
        <div className="button-stack end-screen__actions">
          {actions.map((a) => (
            <OptionCard key={a.label} label={a.label} onClick={a.onClick} />
          ))}
        </div>
      )}
    </div>
  );
}
