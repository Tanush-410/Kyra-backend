/**
 * When the kiosk asks "Still here?" (Figma "Confirmation" 2043:13383: "We'll delete your session in 30
 * seconds", Still Here / Delete Session). Two reasons, both only once the photo is taken (phase "results"):
 *   away: the camera lost the visitor; the backend ends the visit at leavingEndsAt (session.leaving)
 *   idle: no tap, pinch or gesture for IDLE_MS; the kiosk ends the visit IDLE_GRACE_MS later
 * Pure: tested in lib.test.js.
 */
export const IDLE_MS = 90_000;
export const IDLE_GRACE_MS = 30_000;

export function stillHereState({ session, phase, lastInteraction, now, idleMs = IDLE_MS, graceMs = IDLE_GRACE_MS }) {
  if (!session || phase !== "results") return null;
  let reason = null;
  let endsAt = null;
  if (session.leavingEndsAt) {
    reason = "away";
    endsAt = session.leavingEndsAt;
  } else if (now - lastInteraction >= idleMs) {
    reason = "idle";
    endsAt = lastInteraction + idleMs + graceMs;
  }
  if (!reason) return null;
  return { reason, endsAt, secondsLeft: Math.max(0, Math.ceil((endsAt - now) / 1000)) };
}

/** "We'll delete your session in 30 seconds." */
export function stillHereText(secondsLeft) {
  if (secondsLeft <= 0) return "We’re deleting your session now.";
  return `We’ll delete your session in ${secondsLeft} second${secondsLeft === 1 ? "" : "s"}.`;
}
