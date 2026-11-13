import { useNavigate } from "react-router-dom";
import AppHeader from "../../components/AppHeader.jsx";
import { BUILD_PROFILE, SPECIFIC_SCREEN, WHAT_ARE_YOU_LOOKING_FOR } from "../../lib/onboardingRoutes.js";
import OptionCard from "../../components/OptionCard.jsx";

/** Figma: Onboarding / "How can i help you" (variant B, 2043:8322) */
export default function HowCanIHelpYouScreen({ onJustBrowsing, onKnowWhatIWant }) {
  const navigate = useNavigate();
  const browse = onJustBrowsing || (() => navigate(WHAT_ARE_YOU_LOOKING_FOR));
  const specific = onKnowWhatIWant || (() => navigate(SPECIFIC_SCREEN));
  return (
    <div className="screen">
      <AppHeader />
      <div className="screen__content" style={{ gap: 251, marginTop: 184 }}>
        <h1 className="title title--inset">How can I help you today?</h1>
        <div className="button-stack">
          <OptionCard label="I’m just browsing" width="auto" onClick={browse} />
          <OptionCard label="I know what I’m looking for" width="auto" onClick={specific} />
          {/* Not in the Figma frame: the way into "Rate and changes" (rate what you're wearing). */}
          <OptionCard label="Rate my outfit" width="auto" onClick={() => navigate(`${BUILD_PROFILE}?category=rate`, { state: { id: "rate" } })} />
        </div>
      </div>
    </div>
  );
}
