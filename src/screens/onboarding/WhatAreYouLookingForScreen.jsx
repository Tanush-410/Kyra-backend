import { useNavigate } from "react-router-dom";
import AppHeader from "../../components/AppHeader.jsx";
import { BUILD_PROFILE, SHOPFOR } from "../../lib/onboardingRoutes.js";
import OptionCard from "../../components/OptionCard.jsx";

/** Figma: Onboarding / "What r u looking for" (2043:13023) */
export default function WhatAreYouLookingForScreen({ onOutfit, onPickAPiece }) {
  const navigate = useNavigate();
  // Outfit: straight to the analysis (through Build your profile). Pick a piece: menswear or womenswear.
  const outfit = onOutfit || (() => navigate(BUILD_PROFILE));
  const piece = onPickAPiece || (() => navigate(SHOPFOR));
  return (
    <div className="screen">
      <AppHeader />
      <div className="screen__content" style={{ gap: 300 }}>
        <h1 className="title title--inset">What are you looking for?</h1>
        <div className="button-row">
          <OptionCard label="Outfit" width="w500" onClick={outfit} />
          <OptionCard label="Pick a Piece" width="w500" onClick={piece} />
        </div>
      </div>
    </div>
  );
}
