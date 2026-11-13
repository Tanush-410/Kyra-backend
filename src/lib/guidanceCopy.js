/**
 * What the hold-still screen says, for each guidance state the backend camera reports
 * (sidecar guidance.py: no_person, too_dark, too_close, too_far, move_left, move_right, not_standing,
 * face_hidden, blurry, moving, ready). The wording follows the Too Far / Out of Frame / Too Close designs.
 *
 * There is no "multiple people" message: the backend follows the nearest person and ignores the rest.
 */
export const COPY = {
  loading: { title: "Getting ready…" },
  "no-person": {
    title: "Out of frame!",
    body: "Please adjust your position until your full body is visible in the mirror.",
  },
  "out-of-frame": {
    title: "Out of frame!",
    body: "Please adjust your position until your full body is visible in the mirror.",
  },
  "too-far": {
    title: "Too far!",
    body: "Please step closer. You’re a little far away for me to see you clearly.",
  },
  "too-close": {
    title: "Too close!",
    body: "Please step back. Move back gently until you’re standing on the marked line.",
  },
  multiple: {
    title: "Multiple Faces Found",
    body: "Please ensure only one person is in the frame to continue.",
  },
  "move-left": {
    title: "Almost there!",
    body: "Please move a little to your left, so you’re in the middle of the mirror.",
  },
  "move-right": {
    title: "Almost there!",
    body: "Please move a little to your right, so you’re in the middle of the mirror.",
  },
  "too-dark": {
    title: "A little dark!",
    body: "Please step into the light, so I can see your true colours.",
  },
  "not-standing": {
    title: "Stand tall!",
    body: "Please stand up straight, facing the mirror.",
  },
  "face-hidden": {
    title: "Face the mirror!",
    body: "Please look at the mirror, so I can see your face clearly.",
  },
  "camera-unavailable": {
    title: "Camera unavailable",
    body: "The mirror’s camera isn’t working right now. Please ask a member of staff for help.",
  },
};

const BY_STATE = {
  no_person: "no-person",
  too_close: "too-close",
  too_far: "too-far",
  move_left: "move-left",
  move_right: "move-right",
  too_dark: "too-dark",
  not_standing: "not-standing",
  face_hidden: "face-hidden",
};

const CAMERA_DOWN = ["unavailable", "error", "failed", "stopped"];

/**
 * kind "hold": in position (the green frame); count is 3, 2, 1 once the capture is counting down.
 * kind "guide": a COPY entry telling the visitor what to change.
 * kind "loading": the camera hasn't reported yet.
 */
export function guidanceView({ perception, camera, count }) {
  if (CAMERA_DOWN.includes(camera)) return { kind: "guide", copy: COPY["camera-unavailable"] };
  // Before the camera's first report (Figma: the "Loading" state, the screen without guidance).
  if (!perception) return { kind: "loading", copy: COPY.loading };
  if (perception.state === "ready" || perception.state === "moving" || perception.state === "blurry") {
    return { kind: "hold", count: perception.state === "ready" ? count : null };
  }
  const key = BY_STATE[perception.state];
  if (key) return { kind: "guide", copy: COPY[key] };
  // A state this UI doesn't know yet: the backend's own message is visitor-ready.
  return { kind: "guide", copy: perception.message ? { title: perception.message } : COPY.loading };
}
