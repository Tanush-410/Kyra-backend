import { useEffect, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import CameraFeed from "../../components/CameraFeed.jsx";
import CameraGuide from "../../components/CameraGuide.jsx";
import { CAMERA_SOURCE } from "../../config.js";
import { useCamera } from "../../context/CameraContext.jsx";
import { useKyraSession } from "../../context/KyraSessionContext.jsx";
import { useBodyScan } from "../../hooks/useBodyScan.js";
import { COPY, guidanceView } from "../../lib/guidanceCopy.js";
import { intentFromLocation, intentQuery, visitIntent } from "../../lib/visitIntent.js";
import { countdown, phaseOf } from "../../state/sessionReducer.js";
import { CONSENT } from "./ConsentScreen.jsx";

export const RESULT = "/welcome/looking-for-today/surpriseme/analysis/holdstill/analysisres";

/** The green "Great, hold still!" layout (Figma 2043:18550), with the check or the 3, 2, 1. */
function holdContent(count) {
  return {
    title: "Great, hold still!",
    titleHeight: 256,
    contentWidth: 791,
    gap: 120,
    bracketsSrc: `${import.meta.env.BASE_URL}assets/brand/greenframe.png`,
    badge:
      count != null ? (
        <div className="camera-guide__count">{count}</div>
      ) : (
        <img className="camera-guide__badge" src={`${import.meta.env.BASE_URL}assets/brand/greenframe.png`} alt="" />
      ),
  };
}

/** A clock that ticks only while needed (for the countdown between perception events). */
function useNow(active, everyMs = 200) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [active, everyMs]);
  return now;
}

/**
 * Backend camera: the backend measures the visitor and captures when they hold a good pose for
 * holdMs (3 s). This screen shows its guidance, and moves on as soon as the capture happened.
 */
function BackendHoldStill() {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const { state } = useKyraSession();
  const { status: previewStatus } = useCamera();
  const phase = phaseOf(state.session);
  const ready = Boolean(state.perception?.ready && state.perception?.armed);
  const now = useNow(ready);

  useEffect(() => {
    if (phase === "results") navigate(RESULT, { replace: true });
  }, [phase, navigate]);

  // Opened directly, or the visit ended (the visitor walked away): ask again, with the same choices.
  if (phase === "none" || phase === "ended") {
    return <Navigate to={`${CONSENT}${intentQuery(intentFromLocation(location, params))}`} replace />;
  }

  const view =
    phase === "error"
      ? { kind: "guide", copy: { title: "Something went wrong", body: state.session.error } }
      : guidanceView({
          perception: state.perception,
          camera: previewStatus === "error" && state.camera !== "running" ? "error" : state.camera,
          count: countdown(state.perception, now),
        });
  const inPosition = view.kind === "hold";
  return (
    <CameraGuide
      background={<CameraFeed />}
      // darker while giving instructions (as designed), lighter once you are in position
      overlayOpacity={inPosition ? 0.3 : 0.66}
      {...(inPosition ? holdContent(view.count) : view.copy)}
    />
  );
}

/**
 * Browser camera (VITE_CAMERA_SOURCE=browser): the team's body scan finds the pose in this browser,
 * counts down and takes the photo, which starts the visit. The photo stays in memory.
 */
function BrowserHoldStill() {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const { videoRef } = useCamera();
  const { start } = useKyraSession();
  const [uploadError, setUploadError] = useState("");
  const raw = intentFromLocation(location, params);
  const intentRef = useRef(raw);
  intentRef.current = raw;
  const consented = Boolean(location.state?.consented);

  const { state, count, error } = useBodyScan({
    videoRef,
    enabled: consented && !uploadError,
    onCapture: async (photo) => {
      try {
        await start(visitIntent(intentRef.current), { imageDataUrl: photo });
        navigate(RESULT, { replace: true });
      } catch (err) {
        setUploadError(err.message);
      }
    },
  });

  if (!consented) return <Navigate to={`${CONSENT}${intentQuery(raw)}`} replace />;

  const inPosition = state === "hold" || state === "countdown" || state === "captured";
  let content;
  if (uploadError) content = { title: "Something went wrong", body: uploadError };
  else if (inPosition) content = holdContent(state === "countdown" ? count : null);
  else if (state === "error") content = { title: "Camera check unavailable", body: error };
  else content = COPY[state] ?? COPY.loading;

  return <CameraGuide background={<CameraFeed />} overlayOpacity={inPosition ? 0.3 : 0.66} {...content} />;
}

/**
 * Figma: Analysis / "Hold still" (2043:18550).
 * Shows the live camera, guides the person until their full body is in frame, counts 3, 2, 1,
 * then the photo is taken and the results screen follows.
 */
export default function HoldStillScreen() {
  return CAMERA_SOURCE === "browser" ? <BrowserHoldStill /> : <BackendHoldStill />;
}
