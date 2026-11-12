import { useEffect, useRef } from "react";
import { API_BASE, getToken } from "../config.js";
import { useCamera } from "../context/CameraContext.jsx";
import { startMjpegStream } from "../lib/mjpegStream.js";

/**
 * Shows the live camera as a mirror.
 *
 * Backend camera: this opens its own stream of just the part of the camera's view the screen shows, cut
 * from the full-resolution frame and sized to this display. The shared stream (CameraProvider) is a small
 * whole-frame preview for hand tracking; stretched over a 1080 x 3840 screen it would look blurry.
 * Browser camera: the stream CameraProvider already opened.
 */
export default function CameraFeed({ streamRef: streamRefProp }) {
  const camera = useCamera();
  const streamRef = streamRefProp ?? camera.streamRef;
  const backend = camera.source === "backend";
  const ref = useRef(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return undefined;

    if (backend) {
      // The screen's shape, and its real height in device pixels (the kiosk canvas is scaled to fit).
      const aspect = (video.clientWidth || 1080) / (video.clientHeight || 3840);
      const height = Math.round(Math.min(2160, Math.max(240, video.getBoundingClientRect().height * (window.devicePixelRatio || 1))));
      const token = getToken();
      const feed = startMjpegStream({
        url: `${API_BASE}/api/v2/preview.mjpg?aspect=${aspect.toFixed(4)}&height=${height}`,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      video.srcObject = feed.stream;
      video.play().catch(() => {});
      return () => feed.stop();
    }

    let timer = 0;
    const attach = () => {
      if (!streamRef.current) return false;
      video.srcObject = streamRef.current;
      video.play().catch(() => {});
      return true;
    };
    if (!attach()) {
      timer = setInterval(() => attach() && clearInterval(timer), 200);
    }
    return () => clearInterval(timer);
  }, [streamRef, backend]);

  // The backend's preview is already a mirror image: flipping it again would undo that.
  const cls = camera.mirrored ? "camera-feed camera-feed--mirrored" : "camera-feed";
  return <video ref={ref} className={cls} autoPlay muted playsInline />;
}
