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

// icon: a file in public/assets/icons. Icons without a ring get one in the colour of their place
// (the design uses orange, green, white, top to bottom).
const LEVERS = {
  longer: [
    { label: "Pointed-toe shoes", icon: "lever-heels.png" },
    { label: "Cropped hems", icon: "lever-tee.png" },
    { label: "Wide-leg trousers", icon: "lever-trousers.png" },
  ],
  balance: [
    { label: "V-necklines", icon: "lever-tee.png" },
    { label: "Straight-leg trousers", icon: "lever-trousers.png" },
    { label: "Structured bags", icon: "bag-women.png" },
  ],
  add: [
    { label: "Layered tops", icon: "lever-tee.png" },
    { label: "Textured fabrics", icon: "dress-women.png" },
    { label: "Wide-leg trousers", icon: "lever-trousers.png" },
  ],
  reduce: [
    { label: "Tonal outfits", icon: "dress-women.png" },
    { label: "Vertical lines", icon: "lever-trousers.png" },
    { label: "Sleek shoes", icon: "lever-heels.png" },
  ],
};
const RINGS = ["#dfa678", "#aaf867", "#ffffff"];

/** The goal shown first: petite -> look longer; broad -> balance width; slim -> add volume. */
export function defaultGoal(profile) {
  if (profile?.heightImpression === "petite") return "longer";
  if (profile?.build === "broad") return "balance";
  if (profile?.build === "slim") return "add";
  return "longer";
}

// The design's three icons are exported with their rings (design/export-1, "Fit analysis").
const RINGED = new Set(["lever-heels.png", "lever-tee.png", "lever-trousers.png"]);

/** [{ label, icon, ring }]: ring is the colour to draw around the icon, or null when the image has one. */
export function leversFor(goal) {
  return (LEVERS[goal] || LEVERS.longer).map((lever, i) => ({ ...lever, ring: RINGED.has(lever.icon) ? null : RINGS[i] }));
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
