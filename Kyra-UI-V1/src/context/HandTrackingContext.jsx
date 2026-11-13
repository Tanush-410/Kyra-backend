// import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
// import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
// import { useCamera } from "./CameraContext.jsx";

// // Files served from /public (see setup steps).
// const WASM_URL = "/mediapipe/wasm";
// const MODEL_URL = "/mediapipe/hand_landmarker.task";

// const PINCH_ON = 0.25;  // thumb-index gap / hand size below this = pinch
// const PINCH_OFF = 0.4;  // must open past this to release
// const SMOOTHING = 0.4;  // higher = snappier, lower = smoother

// const HandTrackingContext = createContext(null);

// async function assertServed(url) {
//   let res;
//   try {
//     res = await fetch(url, { cache: "no-store" });
//   } catch {
//     throw new Error(`cannot reach ${url}`);
//   }
//   const type = res.headers.get("content-type") || "";
//   if (!res.ok || type.includes("text/html")) {
//     throw new Error(`missing file: ${url} (HTTP ${res.status})`);
//   }
// }

// async function createLandmarker(say) {
//   say("Checking hand tracking files…");
//   await assertServed(`${WASM_URL}/vision_wasm_internal.js`);
//   await assertServed(`${WASM_URL}/vision_wasm_internal.wasm`);
//   await assertServed(MODEL_URL);

//   say("Loading hand tracking…");
//   const vision = await FilesetResolver.forVisionTasks(WASM_URL);
//   const make = (delegate) =>
//     HandLandmarker.createFromOptions(vision, {
//       baseOptions: { modelAssetPath: MODEL_URL, delegate },
//       runningMode: "VIDEO",
//       numHands: 1,
//     });
//   try {
//     return await make("GPU");
//   } catch (gpuErr) {
//     console.warn("[hand] GPU delegate failed, trying CPU", gpuErr);
//     return await make("CPU");
//   }
// }

// /**
//  * ONE hand detector for the whole app. Mount it once, inside <CameraProvider>
//  * and outside <Routes>, so it keeps running when screens change.
//  * It also renders the red/green hand cursor.
//  */
// export function HandTrackingProvider({ children, mirror = true }) {
//   const { videoRef } = useCamera();
//   const cursorRef = useRef(null);
//   const handlers = useRef(new Set());       // pinch listeners
//   const frameHandlers = useRef(new Set());  // per-frame listeners (e.g. wave detection)
//   const [status, setStatus] = useState("Loading hand tracking…");

//   const register = useCallback((fn) => {
//     handlers.current.add(fn);
//     return () => handlers.current.delete(fn);
//   }, []);

//   const registerFrame = useCallback((fn) => {
//     frameHandlers.current.add(fn);
//     return () => frameHandlers.current.delete(fn);
//   }, []);

//   useEffect(() => {
//     let landmarker = null;
//     let raf = 0;
//     let cancelled = false;
//     let lastVideoTime = -1;
//     let pinching = false;
//     let sx = null;
//     let sy = null;
//     let lastStatus = "";
//     let warnedMissing = false;

//     const say = (s) => {
//       if (s !== lastStatus) {
//         lastStatus = s;
//         setStatus(s);
//       }
//     };
//     const hideCursor = () => {
//       if (cursorRef.current) cursorRef.current.style.display = "none";
//     };

//     const tick = () => {
//       if (cancelled) return;

//       let video = videoRef?.current ?? null;
//       if (!video) {
//         video = Array.from(document.querySelectorAll("video")).find((v) => v.srcObject) ?? null;
//       }

//       if (!video) {
//         if (!warnedMissing) {
//           warnedMissing = true;
//           console.warn("[hand] no camera video found", {
//             videoElementsInDom: document.querySelectorAll("video").length,
//           });
//         }
//         say("Waiting for camera…");
//       } else if (video.readyState < 2) {
//         say("Waiting for camera video to start playing…");
//       } else if (video.currentTime !== lastVideoTime) {
//         lastVideoTime = video.currentTime;
//         const lm = landmarker.detectForVideo(video, performance.now()).landmarks?.[0];

//         if (lm) {
//           const thumb = lm[4];
//           const index = lm[8];

//           // Map the camera frame onto whichever screen is currently mounted.
//           const area = document.querySelector(".screen");
//           const rect = area?.getBoundingClientRect() ?? {
//             left: 0,
//             top: 0,
//             width: window.innerWidth,
//             height: window.innerHeight,
//           };

//           // Pointer = midpoint of thumb and index tips, so it stays put while pinching.
//           const nx = (thumb.x + index.x) / 2;
//           const px = mirror ? 1 - nx : nx;
//           const py = (thumb.y + index.y) / 2;
//           const tx = rect.left + px * rect.width;
//           const ty = rect.top + py * rect.height;
//           sx = sx === null ? tx : sx + (tx - sx) * SMOOTHING;
//           sy = sy === null ? ty : sy + (ty - sy) * SMOOTHING;

//           const vw = video.videoWidth || 1;
//           const vh = video.videoHeight || 1;
//           const gap = Math.hypot((thumb.x - index.x) * vw, (thumb.y - index.y) * vh);
//           const handSize = Math.hypot((lm[0].x - lm[9].x) * vw, (lm[0].y - lm[9].y) * vh) || 1;
//           const ratio = gap / handSize;

//           const wasPinching = pinching;
//           if (!pinching && ratio < PINCH_ON) pinching = true;
//           else if (pinching && ratio > PINCH_OFF) pinching = false;

//           const el = cursorRef.current;
//           if (el) {
//             el.style.display = "block";
//             el.style.transform = `translate(${sx - 24}px, ${sy - 24}px) scale(${pinching ? 0.7 : 1})`;
//             el.style.backgroundColor = pinching ? "#4CAF50" : "#ff4081";
//           }
//           say(pinching ? "Pinching" : "Hand detected: pinch to click");
//           frameHandlers.current.forEach((fn) => fn({ landmarks: lm }));

//           if (pinching && !wasPinching) {
//             handlers.current.forEach((fn) => fn({ x: sx, y: sy }));
//           }
//         } else {
//           pinching = false;
//           sx = sy = null;
//           hideCursor();
//           say("No hand detected. Hold your hand up.");
//           frameHandlers.current.forEach((fn) => fn({ landmarks: null }));
//         }
//       }
//       raf = requestAnimationFrame(tick);
//     };

//     (async () => {
//       try {
//         const lmk = await createLandmarker(say);
//         if (cancelled) {
//           lmk.close();
//           return;
//         }
//         landmarker = lmk;
//         say("Hand tracking ready");
//         tick();
//       } catch (err) {
//         console.error("[hand] startup failed:", err);
//         say(`Hand tracking error: ${err.message}`);
//       }
//     })();

//     return () => {
//       cancelled = true;
//       cancelAnimationFrame(raf);
//       landmarker?.close();
//     };
//   }, [videoRef, mirror]);

//   return (
//     <HandTrackingContext.Provider value={{ register, registerFrame, status }}>
//       {children}
//       <div
//         ref={cursorRef}
//         style={{
//           position: "fixed",
//           top: 0,
//           left: 0,
//           display: "none",
//           width: 48,
//           height: 48,
//           borderRadius: "50%",
//           border: "3px solid white",
//           backgroundColor: "#ff4081",
//           boxShadow: "0 0 12px rgba(0,0,0,0.4)",
//           pointerEvents: "none",
//           zIndex: 9999,
//           transition: "background-color 0.1s ease",
//         }}
//       />
//     </HandTrackingContext.Provider>
//   );
// }

// export function useHandTracking() {
//   const ctx = useContext(HandTrackingContext);
//   if (!ctx) throw new Error("useHandPointer must be used inside <HandTrackingProvider>");
//   return ctx;
// }

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import { useCamera } from "./CameraContext.jsx";
import { createSwipeDetector, holdStep, mainHand, palmPoint, steadyForPinch } from "../lib/handGestures.js";

// Files served from /public (see setup steps).
//const WASM_URL = "/mediapipe/wasm";
const WASM_URL = `${import.meta.env.BASE_URL}mediapipe/wasm`;
const MODEL_URL = `${import.meta.env.BASE_URL}mediapipe/hand_landmarker.task`;

const PINCH_ON = 0.25;  // thumb-index gap / hand size below this = pinch
const PINCH_OFF = 0.4;  // must open past this to release
const SMOOTHING = 0.4;  // higher = snappier, lower = smoother

const HandTrackingContext = createContext(null);

const CLICK_TOLERANCE = 40; // px around a button that still counts as a hit
const CLICKABLE = 'button, a[href], [role="button"], [data-pinch]';
const DRAG_PX = 60; // a pinch that moves further than this before opening is a drag, not a click

/** Is (x, y) on el, within the click tolerance? */
function near(el, x, y) {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  return Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom)) <= CLICK_TOLERANCE;
}

/** The pinchable element nearest (x, y), within tolerance, that isn't greyed out or behind a dialog. */
function targetAt(x, y, selector = CLICKABLE) {
  let best = null;
  let bestDist = Infinity;
  document.querySelectorAll(selector).forEach((el) => {
    // Greyed-out buttons, and anything behind an open dialog (marked inert), can't be pinched.
    if (el.disabled || el.closest("[inert]")) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const dx = Math.max(r.left - x, 0, x - r.right);
    const dy = Math.max(r.top - y, 0, y - r.bottom);
    const dist = Math.hypot(dx, dy);
    if (dist <= CLICK_TOLERANCE && dist < bestDist) {
      best = el;
      bestDist = dist;
    }
  });
  return best;
}

/** Real .click() on the clickable element nearest the pinch point (within tolerance). */
function clickAt(x, y) {
  const best = targetAt(x, y);
  if (best) {
    console.log("[hand] pinch at", Math.round(x), Math.round(y), "-> clicking", best.textContent?.trim() || best.tagName);
    best.click();
  } else {
    console.log("[hand] pinch at", Math.round(x), Math.round(y), "-> no button within", CLICK_TOLERANCE, "px");
  }
  return !!best;
}

async function assertServed(url) {
  let res;
  try {
    res = await fetch(url, { cache: "no-store" });
  } catch {
    throw new Error(`cannot reach ${url}`);
  }
  const type = res.headers.get("content-type") || "";
  if (!res.ok || type.includes("text/html")) {
    throw new Error(`missing file: ${url} (HTTP ${res.status})`);
  }
}

async function createLandmarker(say) {
  say("Checking hand tracking files…");
  await assertServed(`${WASM_URL}/vision_wasm_internal.js`);
  await assertServed(`${WASM_URL}/vision_wasm_internal.wasm`);
  await assertServed(MODEL_URL);

  say("Loading hand tracking…");
  const vision = await FilesetResolver.forVisionTasks(WASM_URL);
  const make = (delegate) =>
    HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: "VIDEO",
      numHands: 2, // then only the main hand counts (lib/handGestures.js mainHand)
    });
  try {
    return await make("GPU");
  } catch (gpuErr) {
    console.warn("[hand] GPU delegate failed, trying CPU", gpuErr);
    return await make("CPU");
  }
}

/**
 * ONE hand detector for the whole app. Mount it once, inside <CameraProvider>
 * and outside <Routes>, so it keeps running when screens change.
 * It also renders the red/green hand cursor.
 */
// mirror: flip the pointer left-right. By default only when the camera frames aren't mirror images
// already (the backend's preview is; a browser webcam isn't).
export function HandTrackingProvider({ children, mirror }) {
  const { videoRef, mirrored } = useCamera();
  const flip = mirror ?? !mirrored;
  const cursorRef = useRef(null);
  const handlers = useRef(new Set());       // pinch listeners
  const frameHandlers = useRef(new Set());  // per-frame listeners (e.g. wave detection)
  const swipeHandlers = useRef(new Set());  // swipe listeners (only Suggestions): no listener, no swipes
  const [status, setStatus] = useState("Loading hand tracking…");

  const register = useCallback((fn) => {
    handlers.current.add(fn);
    return () => handlers.current.delete(fn);
  }, []);

  const registerFrame = useCallback((fn) => {
    frameHandlers.current.add(fn);
    return () => frameHandlers.current.delete(fn);
  }, []);

  const registerSwipe = useCallback((fn) => {
    swipeHandlers.current.add(fn);
    return () => swipeHandlers.current.delete(fn);
  }, []);

  // Development only (npm run dev): window.__kyraHand.swipe("left" | "right") for checks without a camera.
  useEffect(() => {
    if (!import.meta.env.DEV) return undefined;
    window.__kyraHand = { swipe: (direction) => swipeHandlers.current.forEach((fn) => fn(direction)) };
    return () => delete window.__kyraHand;
  }, []);

  useEffect(() => {
    let landmarker = null;
    let raf = 0;
    let cancelled = false;
    let lastVideoTime = -1;
    let pinching = false;
    let sx = null;
    let sy = null;
    let lastStatus = "";
    let warnedMissing = false;
    const swipe = createSwipeDetector();
    let lastSwipeAt = -Infinity;
    let history = []; // recent { t, x, y } of the pointer, for "is the hand steady?"
    let hold = null; // { el, start }: pinch and hold on [data-pinch-hold] (the bin)
    let drag = null; // { el, x, y }: pinch and drag from [data-pinch-drag] (shop demo)
    const endHold = (fired) => {
      if (!hold) return;
      hold.el.removeAttribute("data-holding");
      hold.el.style.removeProperty("--hold-progress");
      if (fired) hold.el.dispatchEvent(new CustomEvent("pinchhold", { bubbles: true }));
      hold = null;
    };
    const endDrag = (x, y) => {
      if (!drag) return;
      const { el } = drag;
      el.removeAttribute("data-dragging");
      document.querySelectorAll("[data-drop-hover]").forEach((d) => d.removeAttribute("data-drop-hover"));
      if (x != null) {
        if (Math.hypot(x - drag.x, y - drag.y) < DRAG_PX) el.click(); // it didn't move: a plain pinch
        else {
          const drop = targetAt(x, y, "[data-drop]");
          if (drop) el.dispatchEvent(new CustomEvent("pinchdrop", { bubbles: true, detail: { target: drop.dataset.drop } }));
        }
      }
      drag = null;
    };

    const say = (s) => {
      if (s !== lastStatus) {
        lastStatus = s;
        setStatus(s);
      }
    };
    const hideCursor = () => {
      if (cursorRef.current) cursorRef.current.style.display = "none";
    };

    const tick = () => {
      if (cancelled) return;

      let video = videoRef?.current ?? null;
      if (!video) {
        video = Array.from(document.querySelectorAll("video")).find((v) => v.srcObject) ?? null;
      }

      if (!video) {
        if (!warnedMissing) {
          warnedMissing = true;
          console.warn("[hand] no camera video found", {
            videoElementsInDom: document.querySelectorAll("video").length,
          });
        }
        say("Waiting for camera…");
      } else if (video.readyState < 2) {
        say("Waiting for camera video to start playing…");
      } else if (video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;
        const now = performance.now();
        // Only the main hand counts: the largest in view, big enough, not at the picture's edge.
        const lm = mainHand(landmarker.detectForVideo(video, now).landmarks || [], {
          vw: video.videoWidth || 1,
          vh: video.videoHeight || 1,
        });

        if (lm) {
          const thumb = lm[4];
          const index = lm[8];

          // Map the camera frame onto whichever screen is currently mounted.
          const area = document.querySelector(".screen");
          const rect = area?.getBoundingClientRect() ?? {
            left: 0,
            top: 0,
            width: window.innerWidth,
            height: window.innerHeight,
          };

          // Pointer = midpoint of thumb and index tips, so it stays put while pinching.
          const nx = (thumb.x + index.x) / 2;
          const px = flip ? 1 - nx : nx;
          const py = (thumb.y + index.y) / 2;
          const tx = rect.left + px * rect.width;
          const ty = rect.top + py * rect.height;
          sx = sx === null ? tx : sx + (tx - sx) * SMOOTHING;
          sy = sy === null ? ty : sy + (ty - sy) * SMOOTHING;

          const vw = video.videoWidth || 1;
          const vh = video.videoHeight || 1;
          const gap = Math.hypot((thumb.x - index.x) * vw, (thumb.y - index.y) * vh);
          const handSize = Math.hypot((lm[0].x - lm[9].x) * vw, (lm[0].y - lm[9].y) * vh) || 1;
          const ratio = gap / handSize;

          const wasPinching = pinching;
          if (!pinching && ratio < PINCH_ON) pinching = true;
          else if (pinching && ratio > PINCH_OFF) pinching = false;

          const el = cursorRef.current;
          if (el) {
            el.style.display = "block";
            el.style.transform = `translate(${sx - 24}px, ${sy - 24}px) scale(${pinching ? 0.2 : 0.5})`;
            el.style.backgroundColor = pinching ? "#010d01" : "#f6ecf0";
          }
          document.querySelectorAll(CLICKABLE).forEach((btn) => {
  const r = btn.getBoundingClientRect();
  const isInside =
    r.width > 0 &&
    r.height > 0 &&
    sx >= r.left &&
    sx <= r.right &&
    sy >= r.top &&
    sy <= r.bottom;

  if (isInside) {
    btn.setAttribute("data-hand-hovered", "true");
  } else {
    btn.removeAttribute("data-hand-hovered");
  }
});
          say(pinching ? "Pinching" : "Hand detected: pinch to click");
          frameHandlers.current.forEach((fn) => fn({ landmarks: lm }));

          // Swipes, only while a screen listens (Suggestions).
          if (swipeHandlers.current.size) {
            const direction = swipe.feed({ t: now, ...palmPoint(lm, { mirror: flip }) });
            if (direction) {
              lastSwipeAt = now;
              swipeHandlers.current.forEach((fn) => fn(direction));
            }
          } else {
            swipe.feed(null);
          }
          history = [...history.filter((h) => now - h.t <= 300), { t: now, x: px, y: py }];

          if (pinching && !wasPinching) {
            // A pinch while the hand sweeps (a swipe) presses nothing.
            const ignored = !steadyForPinch(history, now, { lastSwipeAt });
            const target = ignored ? null : targetAt(sx, sy);
            if (ignored) {
              console.log("[hand] pinch ignored: the hand is moving");
            } else if (target?.hasAttribute("data-pinch-hold")) {
              hold = { el: target, start: now }; // the bin: hold to confirm
              target.setAttribute("data-holding", "");
            } else if (target?.hasAttribute("data-pinch-drag")) {
              drag = { el: target, x: sx, y: sy }; // shop demo: maybe a drag to the cart or bin
              target.setAttribute("data-dragging", "");
            } else {
              handlers.current.forEach((fn) => fn({ x: sx, y: sy }));
              clickAt(sx, sy); // a pinch is a click: fires the element's normal onClick
            }
          }
          if (hold) {
            const step = holdStep(hold, { pinching, inside: near(hold.el, sx, sy), now });
            if (step.done) endHold(true);
            else if (step.cancelled) endHold(false);
            else hold.el.style.setProperty("--hold-progress", step.progress.toFixed(3));
          }
          if (drag) {
            document.querySelectorAll("[data-drop]").forEach((d) => d.toggleAttribute("data-drop-hover", near(d, sx, sy)));
            if (!pinching) endDrag(sx, sy);
          }
        } else {
          pinching = false;
          sx = sy = null;
          endHold(false);
          endDrag(null, null);
          swipe.feed(null);
          history = [];
          hideCursor();
          say("No hand detected. Hold your hand up.");
          frameHandlers.current.forEach((fn) => fn({ landmarks: null }));
        }
      }
      raf = requestAnimationFrame(tick);
    };

    (async () => {
      try {
        const lmk = await createLandmarker(say);
        if (cancelled) {
          lmk.close();
          return;
        }
        landmarker = lmk;
        say("Hand tracking ready");
        tick();
      } catch (err) {
        console.error("[hand] startup failed:", err);
        say(`Hand tracking error: ${err.message}`);
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      landmarker?.close();
    };
  }, [videoRef, flip]);

  return (
    <HandTrackingContext.Provider value={{ register, registerFrame, registerSwipe, status }}>
      {children}
      <div
        ref={cursorRef}
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          display: "none",
          width: 48,
          height: 48,
          borderRadius: "50%",
          border: "3px solid white",
          backgroundColor: "#ddd5d7",
          boxShadow: "0 0 12px rgba(0,0,0,0.4)",
          pointerEvents: "none",
          zIndex: 9999,
          transition: "background-color 0.1s ease",
        }}
      />
    </HandTrackingContext.Provider>
  );
}

export function useHandTracking() {
  const ctx = useContext(HandTrackingContext);
  if (!ctx) throw new Error("useHandPointer must be used inside <HandTrackingProvider>");
  return ctx;
}