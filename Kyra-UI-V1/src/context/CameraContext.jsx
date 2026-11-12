import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { API_BASE, CAMERA_SOURCE, getToken } from "../config.js";
import { startMjpegStream } from "../lib/mjpegStream.js";

const CameraContext = createContext(null);

/**
 * One camera stream for the whole app (hand tracking, wave detection, the camera feed), kept alive across
 * screens in a hidden <video>.
 *
 * source "backend" (default): the KYRA backend owns the camera (its sidecar measures and captures the
 *   visitor). This shows the backend's live preview, which is already mirrored. One owner means no
 *   "camera in use" errors (Windows allows only one program per camera).
 * source "browser": this browser's own webcam (VITE_CAMERA_SOURCE=browser). Not mirrored.
 *
 * value: { videoRef, streamRef, mirrored, source, status, error }
 *   mirrored: the frames are already mirror images, so nothing should flip them again.
 */
export function CameraProvider({ children, source = CAMERA_SOURCE }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [status, setStatus] = useState("connecting");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    let stop = () => {};

    const attach = async (stream) => {
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
    };

    if (source === "backend") {
      const token = getToken();
      const preview = startMjpegStream({
        url: `${API_BASE}/api/v2/preview.mjpg`,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        onStatus: (next, message = "") => {
          if (cancelled) return;
          setStatus(next);
          setError(message);
        },
      });
      stop = preview.stop;
      attach(preview.stream);
    } else {
      (async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
          if (cancelled) {
            // StrictMode runs this effect twice in dev; don't leak the first stream.
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          stop = () => stream.getTracks().forEach((t) => t.stop());
          setStatus("running");
          await attach(stream);
        } catch (err) {
          console.error("Global camera access failed:", err);
          if (!cancelled) {
            setStatus("error");
            setError(err.message);
          }
        }
      })();
    }

    return () => {
      cancelled = true;
      stop();
      streamRef.current = null;
    };
  }, [source]);

  const value = { videoRef, streamRef, mirrored: source === "backend", source, status, error };

  return (
    <CameraContext.Provider value={value}>
      {/* Kept off-screen rather than display:none, which can stop frame decoding. */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={{
          position: "fixed",
          left: -9999,
          top: 0,
          width: 640,
          height: 480,
          opacity: 0,
          pointerEvents: "none",
        }}
      />
      {children}
    </CameraContext.Provider>
  );
}

export function useCamera() {
  const ctx = useContext(CameraContext);
  if (!ctx) throw new Error("useCamera must be used inside <CameraProvider>");
  return ctx;
}
