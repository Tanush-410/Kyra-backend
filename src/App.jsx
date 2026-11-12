import { BrowserRouter, Route, Routes } from "react-router-dom";
import ScreenFrame from "./components/ScreenFrame.jsx";
import StaffNotice from "./components/StaffNotice.jsx";
import { CameraProvider } from "./context/CameraContext.jsx";
import { HandTrackingProvider } from "./context/HandTrackingContext.jsx";
import { KyraSessionProvider } from "./context/KyraSessionContext.jsx";
import AnalysisScreen from "./screens/onboarding/AnalysisScreen.jsx";
import ConsentScreen from "./screens/onboarding/ConsentScreen.jsx";
import FemaleSomethingSpecificScreen from "./screens/onboarding/FemaleSomethingSpecificScreen.jsx";
import HoldStillScreen from "./screens/onboarding/HoldStillScreen.jsx";
import ListeningScreen from "./screens/onboarding/ListeningScreen.jsx";
import LookingForTodayScreen from "./screens/onboarding/LookingForTodayScreen.jsx";
import LookResultScreen from "./screens/onboarding/LookResultScreen.jsx";
import MaleSomethingSpecificScreen from "./screens/onboarding/MaleSomethingSpecificScreen.jsx";
import ShoppingForScreen from "./screens/onboarding/ShoppingForScreen.jsx";
import SpecificScreen from "./screens/onboarding/SpecificScreen.jsx";
import SplashScreen from "./screens/onboarding/SplashScreen.jsx";
import SurpriseMeScreen from "./screens/onboarding/SurpriseMeScreen.jsx";
import TellUsWhatYouHaveInMindScreen from "./screens/onboarding/TellUsWhatYouHaveInMindScreen.jsx";
import WelcomeScreen from "./screens/onboarding/WelcomeScreen.jsx";

// The router's base is the build's base path (vite.config.js): "/Kyra-UI-V1" by default.
const BASENAME = import.meta.env.BASE_URL.replace(/\/+$/, "") || "/";

/**
 * Onboarding flow. The transitions below are inferred from the Figma notes
 * ("I'M JUST BROWSING -> what are you looking for -> if OUTFIT -> analysis
 * else PICK A PIECE (male/female)"). Anything marked TODO needs confirming.
 *
 * The visit with the KYRA backend: analysis -> consent (starts the visit) -> hold still (the camera
 * captures) -> results (the looks). See README.md, "Connecting to the KYRA backend".
 */
export default function App() {
  return (
    <BrowserRouter basename={BASENAME}>
      <KyraSessionProvider>
        <CameraProvider>
          <HandTrackingProvider>
            <ScreenFrame>
              <Routes>
                <Route path="/" element={<SplashScreen />} />
                <Route path="/welcome" element={<WelcomeScreen />} />
                <Route path="/welcome/looking-for-today" element={<LookingForTodayScreen />} />
                <Route path="/welcome/looking-for-today/surpriseme" element={<SurpriseMeScreen />} />
                <Route path="/welcome/looking-for-today/specificscreen" element={<SpecificScreen />} />
                <Route path="/welcome/looking-for-today/surpriseme/shopfor" element={<ShoppingForScreen />} />
                <Route path="/welcome/looking-for-today/surpriseme/shopfor/malepicks" element={<MaleSomethingSpecificScreen />} />
                <Route path="/welcome/looking-for-today/surpriseme/shopfor/femalepicks" element={<FemaleSomethingSpecificScreen />} />
                <Route path="/welcome/looking-for-today/surpriseme/analysis" element={<AnalysisScreen />} />
                <Route path="/welcome/looking-for-today/surpriseme/analysis/consent" element={<ConsentScreen />} />
                <Route path="/welcome/looking-for-today/specificscreen/voicesearch" element={<TellUsWhatYouHaveInMindScreen />} />
                <Route path="/welcome/looking-for-today/specificscreen/voicesearch/listening" element={<ListeningScreen />} />
                <Route path="/welcome/looking-for-today/surpriseme/analysis/holdstill" element={<HoldStillScreen />} />
                <Route path="/welcome/looking-for-today/surpriseme/analysis/holdstill/analysisres" element={<LookResultScreen />} />
              </Routes>
            </ScreenFrame>
            <StaffNotice />
          </HandTrackingProvider>
        </CameraProvider>
      </KyraSessionProvider>
    </BrowserRouter>
  );
}
