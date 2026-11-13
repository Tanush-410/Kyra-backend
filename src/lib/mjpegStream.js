/**
 * Reads an MJPEG stream (multipart/x-mixed-replace, as the backend's /api/v2/preview.mjpg sends) with
 * fetch and draws every frame onto a canvas. Returns the canvas's MediaStream, so the rest of the app
 * (hand tracking, the camera feed) treats it exactly like a webcam.
 *
 * Why not <img src=...mjpg>: an <img> can't send the token header, and browsers may stop updating
 * images that are off-screen. This works the same whether or not anything is shown.
 */

const SOI = [0xff, 0xd8]; // JPEG start
const EOI = [0xff, 0xd9]; // JPEG end (can't occur inside the image data: 0xFF there is always followed by 0x00)

function indexOf(bytes, marker, from) {
  for (let i = Math.max(0, from); i < bytes.length - 1; i += 1) {
    if (bytes[i] === marker[0] && bytes[i + 1] === marker[1]) return i;
  }
  return -1;
}

/** Splits a growing byte buffer into complete JPEGs. Exported for tests. */
export function createJpegSplitter() {
  let buffer = new Uint8Array(0);
  return function push(chunk) {
    const joined = new Uint8Array(buffer.length + chunk.length);
    joined.set(buffer);
    joined.set(chunk, buffer.length);
    buffer = joined;
    const frames = [];
    for (;;) {
      const start = indexOf(buffer, SOI, 0);
      if (start < 0) {
        buffer = buffer.slice(Math.max(0, buffer.length - 1)); // keep a byte: a marker may be split
        break;
      }
      const end = indexOf(buffer, EOI, start + 2);
      if (end < 0) {
        buffer = buffer.slice(start);
        break;
      }
      frames.push(buffer.slice(start, end + 2));
      buffer = buffer.slice(end + 2);
    }
    return frames;
  };
}

/**
 * Starts drawing the stream. onStatus("connecting" | "running" | "error", message?).
 * Returns { stream, stop }.
 */
export function startMjpegStream({ url, headers = {}, onStatus = () => {}, retryMs = 2000 }) {
  const canvas = document.createElement("canvas");
  canvas.width = 720;
  canvas.height = 405;
  const ctx = canvas.getContext("2d");
  const stream = canvas.captureStream();
  let stopped = false;
  let controller = null;
  let retry = 0;
  let drawing = false;

  const draw = async (jpeg) => {
    if (drawing) return; // still decoding the last frame: drop this one, the next comes shortly
    drawing = true;
    try {
      const bitmap = await createImageBitmap(new Blob([jpeg], { type: "image/jpeg" }));
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
      }
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
    } catch {
      // a corrupt frame: skip it
    } finally {
      drawing = false;
    }
  };

  const connect = async () => {
    if (stopped) return;
    controller = new AbortController();
    onStatus("connecting");
    try {
      const response = await fetch(url, { headers, signal: controller.signal, cache: "no-store" });
      if (!response.ok || !response.body) throw new Error(`camera preview: HTTP ${response.status}`);
      const reader = response.body.getReader();
      const split = createJpegSplitter();
      let first = true;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const frames = split(value);
        if (frames.length) {
          if (first) {
            first = false;
            onStatus("running");
          }
          draw(frames[frames.length - 1]); // only the newest frame matters
        }
      }
      throw new Error("camera preview ended");
    } catch (error) {
      if (stopped) return;
      onStatus("error", error.message);
      retry = setTimeout(connect, retryMs);
    }
  };

  connect();
  return {
    stream,
    stop() {
      stopped = true;
      clearTimeout(retry);
      controller?.abort();
      stream.getTracks().forEach((track) => track.stop());
    },
  };
}
