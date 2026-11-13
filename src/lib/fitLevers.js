/**
 * The Fit Analysis card (Figma "Fit analysis", design/export-1): four goals (Look longer, Balance
 * Width, Add Volume, Reduce Volume) and three "styling levers" for the chosen goal.
 *
 * The backend measures build (slim / medium / broad) and, with a calibrated camera, a height
 * impression (petite / average / tall), and sends fit guidance as sentences (palette.js fitGuidance).
 * It has no body measurements, so the levers are general styling rules per goal, and the goal picked
 * first follows the profile. Pure: unit-tested in lib.test.js.
 */

export const GOALS = [
  { key: "longer", label: "Look longer" },
  { key: "balance", label: "Balance Width" },
  { key: "add", label: "Add Volume" },
  { key: "reduce", label: "Reduce Volume" },
];

// kind decides the icon and its ring colour (the design: shoes orange, tops green, bottoms white).
const LEVERS = {
  longer: [
    { label: "Pointed-toe shoes", kind: "shoes" },
    { label: "Cropped tops", kind: "top" }, // cropped trousers would shorten the leg
    { label: "Wide-leg trousers", kind: "bottom" },
  ],
  // Broad shoulders are balanced with volume below.
  balance: [
    { label: "V-necklines", kind: "top" },
    { label: "Wide-leg or A-line bottoms", kind: "bottom" },
    { label: "Darker tops with lighter bottoms", kind: "top" },
  ],
  add: [
    { label: "Layered tops", kind: "top" },
    { label: "Textured fabrics", kind: "top" },
    { label: "Wide-leg trousers", kind: "bottom" },
  ],
  reduce: [
    { label: "Tonal outfits", kind: "top" },
    { label: "Vertical lines", kind: "bottom" },
    { label: "Defined waist", kind: "bottom" },
  ],
};
const RINGS = { shoes: "#dfa678", top: "#aaf867", bottom: "#ffffff" };
// The design's own icons (a heel, a women's tee; exported with their rings) are for female visitors.
// Everyone else, including visitors whose gender isn't known, gets neutral ones (public/assets/icons).
const DESIGN_ICONS = { shoes: "lever-heels.png", top: "lever-tee.png", bottom: "lever-trousers.png" };
const NEUTRAL_ICONS = { shoes: "shoes.png", top: "tops.png", bottom: "bottoms.png" };

/** The goal shown first: petite -> look longer; broad -> balance width; slim -> add volume. */
export function defaultGoal(profile) {
  if (profile?.heightImpression === "petite") return "longer";
  if (profile?.build === "broad") return "balance";
  if (profile?.build === "slim") return "add";
  return "longer";
}

/**
 * [{ label, kind, icon, ring }]: ring is the colour to draw around the icon, or null when the image
 * has its own (the design's icons, for female visitors).
 */
export function leversFor(goal, { female = false } = {}) {
  return (LEVERS[goal] || LEVERS.longer).map((lever) => ({
    ...lever,
    icon: (female ? DESIGN_ICONS : NEUTRAL_ICONS)[lever.kind],
    ring: female ? null : RINGS[lever.kind],
  }));
}

const BUILD_WORDS = { slim: "a slim frame", medium: "a balanced frame", broad: "a broad frame" };
const HEIGHT_WORDS = { petite: "petite", average: "of average height", tall: "tall" };

/**
 * What the outlines on the silhouette say when pointed at: only what was measured.
 * shoulders: the build reading (and the backend's guidance line for it); height: the height impression.
 * Each is null when the camera didn't measure it.
 */
export function fitNotes(profile, fitGuidance = []) {
  const line = (word) => fitGuidance.find((text) => text.toLowerCase().startsWith(word)) || "";
  const after = (text) => text.replace(/^[^:]+:\s*/, "");
  const build = profile?.build;
  const height = profile?.heightImpression;
  return {
    shoulders: BUILD_WORDS[build]
      ? { title: "Shoulders and frame", text: `Your shoulders suggest ${BUILD_WORDS[build]}.${line(build) ? ` ${capitalise(after(line(build)))}` : ""}` }
      : null,
    height: HEIGHT_WORDS[height]
      ? {
          title: "Height",
          text: `You read as ${HEIGHT_WORDS[height]}${profile?.heightCm ? ` (about ${Math.round(profile.heightCm)} cm)` : ""}.${line(height) ? ` ${capitalise(after(line(height)))}` : ""}`,
        }
      : null,
  };
}

const capitalise = (text) => (text ? text[0].toUpperCase() + text.slice(1) : "");
