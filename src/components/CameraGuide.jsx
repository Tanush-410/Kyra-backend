import AppHeader from "./AppHeader.jsx";
import "./CameraGuide.css";

const BRACKETS = {
  red: `${import.meta.env.BASE_URL}assets/brand/viewfinder.png`, // Figma "Frame 212" (red), the warnings
  green: `${import.meta.env.BASE_URL}assets/brand/greenframe.png`, // Figma "Frame 212" (green), in position
};

/**
 * Shared layout for the camera-positioning screens. Figma: "Too Far" (2043:18481) and its variants,
 * "Hold still" (2043:18550), and the hold-still states Countdown, Loading, Flash and All set.
 * A dark overlay (#313131 at 66%) sits over the camera view; the brackets frame the person.
 *
 * background:     optional live camera element, drawn under the overlay
 * overlay:        false for the plain screen (Loading, All set)
 * brackets:       "red" (warnings), "green" (in position) or "none"
 * contentTop:     place the message block's top here (px from the viewfinder top); by default the
 *                 block is centred on the design's fixed point, so 1-3 line titles all line up
 * titleClassName: extra class for the title (the countdown number)
 * badge:          optional element under the text (the green check)
 */
export default function CameraGuide({
  title,
  body,
  titleHeight,
  titleClassName = "",
  contentWidth,
  contentTop,
  gap,
  badge,
  brackets = "red",
  background,
  overlay = true,
}) {
  return (
    <div className="screen camera-guide">
      {background}
      {overlay && <div className="camera-guide__overlay" />}
      <div className="camera-guide__header">
        <AppHeader />
      </div>

      <div className="camera-guide__frame">
        {BRACKETS[brackets] && (
          <div className="camera-guide__brackets">
            <img src={BRACKETS[brackets]} alt="" />
          </div>
        )}

        <div
          className={`camera-guide__content${contentTop != null ? " camera-guide__content--top" : ""}`}
          style={{
            ...(contentWidth && { width: contentWidth }),
            ...(gap != null && { gap }),
            ...(contentTop != null && { top: contentTop }),
          }}
        >
          {title != null && (
            <h1
              className={`camera-guide__title ${titleClassName}`.trim()}
              style={titleHeight ? { height: titleHeight, overflow: "hidden" } : undefined}
            >
              {title}
            </h1>
          )}
          {body && <p className="camera-guide__body">{body}</p>}
          {badge}
        </div>
      </div>
    </div>
  );
}
