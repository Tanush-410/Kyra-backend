import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import AppHeader from "../../components/AppHeader.jsx";
import { ANALYSIS } from "../../lib/onboardingRoutes.js";

const NEXT_MS = 3000;

/**
 * Figma: Onboarding / "Catagories" (2043:9928): "Let's find the best fit for you by building your profile",
 * just before the analysis intro. Moves on after 3 s (or a tap), with the visitor's choices: the
 * category in the address, the spoken words only in router state.
 */
export default function BuildYourProfileScreen({ onNext }) {
  const navigate = useNavigate();
  const location = useLocation();
  const next = onNext || (() => navigate(`${ANALYSIS}${location.search}`, { state: location.state }));
  useEffect(() => {
    if (onNext) return undefined;
    const timer = setTimeout(next, NEXT_MS);
    return () => clearTimeout(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="screen" onClick={next} role="button" tabIndex={0} aria-label="Continue">
      <AppHeader />
      <div className="screen__content">
        <h1 className="title">Let’s find the best fit for you by building your profile</h1>
      </div>
    </div>
  );
}
