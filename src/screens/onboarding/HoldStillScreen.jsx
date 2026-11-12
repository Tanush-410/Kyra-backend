import { useEffect, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import AppHeader from "../../components/AppHeader.jsx";
import CameraFeed from "../../components/CameraFeed.jsx";
import CameraGuide from "../../components/CameraGuide.jsx";
import KyraLoader from "../../components/KyraLoader.jsx";
import { CAMERA_SOURCE } from "../../config.js";
import { useCamera } from "../../context/CameraContext.jsx";
import { useKyraSession } from "../../context/KyraSessionContext.jsx";
import { useBodyScan } from "../../hooks/useBodyScan.js";
import { captureStage } from "../../lib/captureSequence.js";
import { COPY, guidanceView } from "../../lib/guidanceCopy.js";
import { intentFromLocation, intentQuery, visitIntent } from "../../lib/visitIntent.js";
import { countdown, phaseOf } from "../../state/sessionReducer.js";
import { CONSENT } from "./ConsentScreen.jsx";

export const RESULT = "/welcome/looking-for-today/surpriseme/analysis/holdstill/analysisres";

const asset = (name) => `${import.meta.env.BASE_URL}assets/brand/${name}`;

/**
 * One state of the hold-still screen. Figma ("Anaysis" in "For dev"): the warnings "Too Far"
 * (2043:18481) and its variants, "Hold still" (2043:18550), and the hold-still component's states
 * Loading, Countdown, Flash and All set. Positions measured from the team's exports (design/export-1).
 *
 * view: { kind: "loading" } | { kind: "guide", copy: { title, body } } | { kind: "hold" }
 *       | { kind: "count", count } | { kind: "flash" } | { kind: "allset" }
 */
export function HoldStillView({ view, background = null }) {
  switch (view.kind) {
    case "flash":
      return (
        <div className="screen camera-guide camera-guide--flash" role="img" aria-label="Photo taken">
          <div className="camera-guide__header">
            <AppHeader />
          </div>
        </div>
      );
    case "allset":
      return <CameraGuide brackets="none" overlay={false} contentTop={170} title="All set!" body="Let’s find your perfect fit" />;
    case "loading":
      return (
        <div className="screen camera-guide">
          <div className="camera-guide__header">
            <AppHeader />
          </div>
          {/* Design note: the Kyra star is the loading animation wherever there is a wait. */}
          <KyraLoader label="Getting the camera ready" />
        </div>
      );
    case "count":
      return (
        <CameraGuide
          background={background}
          brackets="green"
          contentTop={170}
          title={view.count}
          titleClassName="camera-guide__title--count"
        />
      );
    case "hold":
      return (
        <CameraGuide
          background={background}
          brackets="green"
          contentTop={170}
          title="Great, hold still!"
          // Figma's title box is 256px (two 143px lines, clipped), which puts the check at y 1012.
          titleHeight={256}
          contentWidth={791}
          gap={120}
          badge={<img className="camera-guide__badge" src={asset("hold-check.png")} alt="" />}
        />
      );
    default:
      return <CameraGuide background={background} {...view.copy} />;
  }
}

/** A clock that ticks only while needed (the countdown between perception events, the flash). */
function useNow(active, everyMs = 100) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [active, everyMs]);
  return now;
}

/**
 * Backend camera: the backend measures the visitor and captures when they hold a good pose for
 * holdMs (3 s). This screen shows its guidance; when the photo is taken it flashes, says "All set!",
 * and moves on.
 */
function BackendHoldStill() {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const { state } = useKyraSession();
  const { status: previewStatus } = useCamera();
  const phase = phaseOf(state.session);
  const ready = Boolean(state.perception?.ready && state.perception?.armed);
  // When this screen saw the capture happen (null until then).
  const [capturedAt, setCapturedAt] = useState(null);
  const sawCapture = useRef(false);
  if (phase === "capture") sawCapture.current = true;

  useEffect(() => {
    if (phase !== "results" || capturedAt != null) return;
    // Reopened after the photo was taken (no capture on this screen): go straight on.
    if (!sawCapture.current) navigate(RESULT, { replace: true });
    else setCapturedAt(Date.now());
  }, [phase, capturedAt, navigate]);

  const now = useNow(ready || capturedAt != null);
  const stage = captureStage(capturedAt, now);
  useEffect(() => {
    if (stage === "done") navigate(RESULT, { replace: true });
  }, [stage, navigate]);

  // Opened directly, or the visit ended (the visitor walked away): ask again, with the same choices.
  if (phase === "none" || phase === "ended") {
    return <Navigate to={`${CONSENT}${intentQuery(intentFromLocation(location, params))}`} replace />;
  }
  if (stage === "flash" || stage === "allset" || stage === "done") return <HoldStillView view={{ kind: stage === "flash" ? "flash" : "allset" }} />;

  let view;
  if (phase === "error") view = { kind: "guide", copy: { title: "Something went wrong", body: state.session.error } };
  else {
    const guide = guidanceView({
      perception: state.perception,
      camera: previewStatus === "error" && state.camera !== "running" ? "error" : state.camera,
      count: countdown(state.perception, now),
    });
    view = guide.kind === "hold" && guide.count != null ? { kind: "count", count: guide.count } : guide;
  }
  return <HoldStillView view={view} background={<CameraFeed />} />;
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
  const [capturedAt, setCapturedAt] = useState(null);
  const [uploaded, setUploaded] = useState(false);
  const raw = intentFromLocation(location, params);
  const intentRef = useRef(raw);
  intentRef.current = raw;
  const consented = Boolean(location.state?.consented);

  const { state, count, error } = useBodyScan({
    videoRef,
    enabled: consented && !uploadError && capturedAt == null,
    onCapture: async (photo) => {
      setCapturedAt(Date.now());
      try {
        await start(visitIntent(intentRef.current), { imageDataUrl: photo });
        setUploaded(true);
      } catch (err) {
        setCapturedAt(null);
        setUploadError(err.message);
      }
    },
  });

  const now = useNow(capturedAt != null);
  const stage = captureStage(capturedAt, now);
  useEffect(() => {
    if (stage === "done" && uploaded) navigate(RESULT, { replace: true });
  }, [stage, uploaded, navigate]);

  if (!consented) return <Navigate to={`${CONSENT}${intentQuery(raw)}`} replace />;
  // "All set!" stays until the photo has reached the backend.
  if (stage !== "live") return <HoldStillView view={{ kind: stage === "flash" ? "flash" : "allset" }} />;

  let view;
  if (uploadError) view = { kind: "guide", copy: { title: "Something went wrong", body: uploadError } };
  else if (state === "countdown" && count != null) view = { kind: "count", count };
  else if (state === "hold" || state === "countdown" || state === "captured") view = { kind: "hold" };
  else if (state === "error") view = { kind: "guide", copy: { title: "Camera check unavailable", body: error } };
  else if (COPY[state]) view = { kind: "guide", copy: COPY[state] };
  else view = { kind: "loading" };
  return <HoldStillView view={view} background={<CameraFeed />} />;
}

/**
 * Figma: Analysis / "Hold still" (2043:18550).
 * Shows the live camera, guides the person until their full body is in frame, counts 3, 2, 1,
 * flashes as the photo is taken, says "All set!", then the results follow.
 */
export default function HoldStillScreen() {
  return CAMERA_SOURCE === "browser" ? <BrowserHoldStill /> : <BackendHoldStill />;
}
