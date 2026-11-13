import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import ScreenFrame from "./components/ScreenFrame.jsx";
import StaffNotice from "./components/StaffNotice.jsx";
import { CameraProvider } from "./context/CameraContext.jsx";
import { HandTrackingProvider } from "./context/HandTrackingContext.jsx";
import { SHOP_DEMO } from "./config.js";
import { KyraSessionProvider } from "./context/KyraSessionContext.jsx";
import { BYE_PATH, EDIT_LOOK_PATH, FIT_PATH, LOOK_PATH, RATE_PATH, RESULTS_PATH, SKIN_TONE_PATH, SUGGESTIONS_PATH } from "./lib/shopRoutes.js";
import AnalysisScreen from "./screens/onboarding/AnalysisScreen.jsx";
import ConsentScreen from "./screens/onboarding/ConsentScreen.jsx";
import FemaleSomethingSpecificScreen from "./screens/onboarding/FemaleSomethingSpecificScreen.jsx";
import HoldStillScreen from "./screens/onboarding/HoldStillScreen.jsx";
import ListeningScreen from "./screens/onboarding/ListeningScreen.jsx";
import LookingForTodayScreen from "./screens/onboarding/LookingForTodayScreen.jsx";
import FitAnalysisScreen from "./screens/results/FitAnalysisScreen.jsx";
import SkinToneScreen from "./screens/results/SkinToneScreen.jsx";
import SuggestionsScreen from "./screens/results/SuggestionsScreen.jsx";
import TryOnScreen from "./screens/results/TryOnScreen.jsx";
import EditLookScreen from "./screens/results/EditLookScreen.jsx";
import RateLookScreen from "./screens/results/RateLookScreen.jsx";
import ByeScreen from "./screens/results/ByeScreen.jsx";
import StillHereGuard from "./components/StillHereGuard.jsx";
import MaleSomethingSpecificScreen from "./screens/onboarding/MaleSomethingSpecificScreen.jsx";
import ShoppingForScreen from "./screens/onboarding/ShoppingForScreen.jsx";
import SpecificScreen from "./screens/onboarding/SpecificScreen.jsx";
import SplashScreen from "./screens/onboarding/SplashScreen.jsx";
import SurpriseMeScreen from "./screens/onboarding/SurpriseMeScreen.jsx";
import TellUsWhatYouHaveInMindScreen from "./screens/onboarding/TellUsWhatYouHaveInMindScreen.jsx";
import WelcomeScreen from "./screens/onboarding/WelcomeScreen.jsx";
import BuildYourProfileScreen from "./screens/onboarding/BuildYourProfileScreen.jsx";
import HowCanIHelpYouScreen from "./screens/onboarding/HowCanIHelpYouScreen.jsx";
import WhatAreYouLookingForScreen from "./screens/onboarding/WhatAreYouLookingForScreen.jsx";
import { BUILD_PROFILE, HOW_CAN_I_HELP, WHAT_ARE_YOU_LOOKING_FOR } from "./lib/onboardingRoutes.js";
import AccountScreen from "./screens/shop/AccountScreen.jsx";

// Development only: the shared components on their own, for screenshot checks (src/dev/). Not built for production.
const ComponentPreview = import.meta.env.DEV ? lazy(() => import("./dev/ComponentPreview.jsx")) : null;

// The shop demo (VITE_SHOP_DEMO=true) has placeholder prices: without it these screens have no route (their
// addresses go back to the results) and are never loaded.
const shopScreen = (load) => (SHOP_DEMO ? lazy(load) : null);
const ProductsScreen = shopScreen(() => import("./screens/shop/ProductsScreen.jsx"));
const CartScreen = shopScreen(() => import("./screens/shop/CartScreen.jsx"));
const CheckoutScreen = shopScreen(() => import("./screens/shop/CheckoutScreen.jsx"));
const FilterScreen = shopScreen(() => import("./screens/shop/FilterScreen.jsx"));
const EditScreen = shopScreen(() => import("./screens/shop/EditScreen.jsx"));
const lazyRoute = (Screen) => (
  <Suspense fallback={null}>
    <Screen />
  </Suspense>
);

// The router's base is the build's base path (vite.config.js): "/Kyra-UI-V1" by default.
const BASENAME = import.meta.env.BASE_URL.replace(/\/+$/, "") || "/";

/**
 * Onboarding flow. The transitions below are inferred from the Figma notes
 * ("I'M JUST BROWSING -> what are you looking for -> if OUTFIT -> analysis
 * else PICK A PIECE (male/female)"). Anything marked TODO needs confirming.
 *
 * The visit with the KYRA backend: analysis -> consent (starts the visit) -> hold still (the camera
 * captures) -> Skin Tone Analysis -> Fit Analysis -> the look. See README.md, "Connecting to the KYRA backend".
 */
export default function App() {
  return (
    <BrowserRouter basename={BASENAME}>
      <KyraSessionProvider>
        <CameraProvider>
          <HandTrackingProvider>
            <ScreenFrame>
              <StillHereGuard>
              <Routes>
                <Route path="/" element={<SplashScreen />} />
                <Route path="/welcome" element={<WelcomeScreen />} />
                <Route path={HOW_CAN_I_HELP} element={<HowCanIHelpYouScreen />} />
                <Route path={WHAT_ARE_YOU_LOOKING_FOR} element={<WhatAreYouLookingForScreen />} />
                <Route path={BUILD_PROFILE} element={<BuildYourProfileScreen />} />
                {/* The design's other version of the second screen (2043:8311), kept but not linked */}
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
                {/* After the photo: Skin Tone -> Fit -> Suggestions -> the look (the first renders meanwhile). */}
                <Route path={SKIN_TONE_PATH} element={<SkinToneScreen />} />
                <Route path={FIT_PATH} element={<FitAnalysisScreen />} />
                <Route path={SUGGESTIONS_PATH} element={<SuggestionsScreen />} />
                <Route path={LOOK_PATH} element={<TryOnScreen />} />
                <Route path={EDIT_LOOK_PATH} element={<EditLookScreen />} />
                <Route path={RATE_PATH} element={<RateLookScreen />} />
                <Route path={BYE_PATH} element={<ByeScreen />} />
                <Route path="/account" element={<AccountScreen />} />
                {SHOP_DEMO ? (
                  <>
                    <Route path="/shop" element={lazyRoute(ProductsScreen)} />
                    <Route path="/shop/cart" element={lazyRoute(CartScreen)} />
                    <Route path="/shop/checkout" element={lazyRoute(CheckoutScreen)} />
                    <Route path="/shop/filter" element={lazyRoute(FilterScreen)} />
                    <Route path="/edit" element={lazyRoute(EditScreen)} />
                  </>
                ) : (
                  <>
                    <Route path="/shop/*" element={<Navigate to={RESULTS_PATH} replace />} />
                    <Route path="/edit" element={<Navigate to={RESULTS_PATH} replace />} />
                  </>
                )}
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
              </StillHereGuard>
            </ScreenFrame>
            <StaffNotice />
          </HandTrackingProvider>
        </CameraProvider>
      </KyraSessionProvider>
    </BrowserRouter>
  );
}
