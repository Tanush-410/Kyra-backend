/**
 * What the hold-still screen shows around the moment the photo is taken (Figma: the hold-still
 * component's states Countdown -> Flash -> All set, in the "Anaysis" section of "For dev").
 *
 * live:   guidance, "Great, hold still!" or the 3, 2, 1
 * flash:  a white flash, like a camera's
 * allset: "All set! Let's find your perfect fit"
 * done:   move on to the next screen (once the photo has also reached the backend)
 */
export const FLASH_MS = 300;
export const ALL_SET_MS = 2000;

export function captureStage(capturedAt, now) {
  if (capturedAt == null) return "live";
  const since = Math.max(0, now - capturedAt);
  if (since < FLASH_MS) return "flash";
  if (since < FLASH_MS + ALL_SET_MS) return "allset";
  return "done";
}
