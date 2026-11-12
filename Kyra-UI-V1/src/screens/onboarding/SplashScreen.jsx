import { useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import AppHeader from "../../components/AppHeader.jsx";
import KyraLogo from "../../components/KyraLogo.jsx";
import { useKyraSession } from "../../context/KyraSessionContext.jsx";
import { useWaveDetector } from "../../hooks/useWaveDetector.js";
import "./SplashScreen.css";

/**
 * Figma: Onboarding / "Splash Screen" (2043:8300). A wave starts.
 * The wave uses the app's one hand detector (HandTrackingProvider, local model files), so nothing
 * extra loads here and it works offline.
 */
export default function SplashScreen() {
  const navigate = useNavigate();
  const { state, end } = useKyraSession();
  const goNext = useCallback(() => navigate("/welcome"), [navigate]);
  useWaveDetector(goNext);

  // Back at the start: whoever was here has finished, so their visit (and photo) goes now.
  const openSession = state.session && !state.session.ended;
  useEffect(() => {
    if (openSession) end();
  }, [openSession, end]);

  return (
    // A click (or pinch) anywhere also starts: for staff testing, and visitors who tap the glass.
    <div className="screen splash" onClick={goNext}>
      <AppHeader />
      <div className="splash__content">
        <KyraLogo />
        <p className="splash__prompt">Ready to explore? Just wave!</p>
      </div>
    </div>
  );
}
