import { lazy, Suspense } from "react";
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
import AccountScreen from "./screens/shop/AccountScreen.jsx";
import CartScreen from "./screens/shop/CartScreen.jsx";
import CheckoutScreen from "./screens/shop/CheckoutScreen.jsx";
import EditScreen from "./screens/shop/EditScreen.jsx";
import FilterScreen from "./screens/shop/FilterScreen.jsx";
import ProductsScreen from "./screens/shop/ProductsScreen.jsx";

// Development only: the shared components on their own, for screenshot checks (src/dev/). Not built for production.
const ComponentPreview = import.meta.env.DEV ? lazy(() => import("./dev/ComponentPreview.jsx")) : null;

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
                <Route path="/shop" element={<ProductsScreen />} />
                <Route path="/shop/cart" element={<CartScreen />} />
                <Route path="/shop/checkout" element={<CheckoutScreen />} />
                <Route path="/shop/filter" element={<FilterScreen />} />
                <Route path="/account" element={<AccountScreen />} />
                <Route path="/edit" element={<EditScreen />} />
                {ComponentPreview && (
                  <Route
                    path="/dev/:name"
                    element={
                      <Suspense fallback={null}>
                        <ComponentPreview />
                      </Suspense>
                    }
                  />
                )}
              </Routes>
            </ScreenFrame>
            <StaffNotice />
          </HandTrackingProvider>
        </CameraProvider>
      </KyraSessionProvider>
    </BrowserRouter>
  );
}
