/**
 * The Skin Tone Analysis card (Figma 2043:13274): five colours with a role each (Core, Core,
 * Supporting, Supporting, Accent) and the three chips (undertone, depth, clarity).
 *
 * The backend sends the visitor's palette (best first) but not these roles or a clarity reading, so
 * they are worked out here from the colours themselves:
 *   - the five best colours are used;
 *   - Core: the two calmest (lowest chroma), the easiest to wear in large pieces;
 *   - Accent: the most vivid one, for a small touch;
 *   - Supporting: the other two;
 *   - clarity: "Clear" when the five are vivid on average, "Soft" when they are muted.
 * Pure: unit-tested in lib.test.js.
 */

/** sRGB hex -> CIELAB (D65). */
export function hexToLab(hex) {
  const clean = String(hex || "").replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(clean)) return null;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(clean.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

export function chromaOf(hex) {
  const lab = hexToLab(hex);
  return lab ? Math.hypot(lab.a, lab.b) : 0;
}

/** Mean chroma at or above this reads as "Clear"; below, "Soft". */
export const CLEAR_CHROMA = 32;

/** [{ name, hex, role }] in display order: Core, Core, Supporting, Supporting, Accent. */
export function paletteRoles(palette = []) {
  const five = palette.filter((c) => hexToLab(c?.hex)).slice(0, 5);
  if (five.length < 3) return five.map((c) => ({ ...c, role: "Core" }));
  const byChroma = [...five].sort((a, b) => chromaOf(a.hex) - chromaOf(b.hex));
  const accent = byChroma[byChroma.length - 1];
  const core = byChroma.slice(0, 2);
  const supporting = five.filter((c) => c !== accent && !core.includes(c));
  return [
    ...core.map((c) => ({ ...c, role: "Core" })),
    ...supporting.map((c) => ({ ...c, role: "Supporting" })),
    { ...accent, role: "Accent" },
  ];
}

export function clarityOf(palette = []) {
  const five = palette.filter((c) => hexToLab(c?.hex)).slice(0, 5);
  if (!five.length) return null;
  const mean = five.reduce((sum, c) => sum + chromaOf(c.hex), 0) / five.length;
  return mean >= CLEAR_CHROMA ? "Clear" : "Soft";
}

const capitalise = (text) => (text ? text[0].toUpperCase() + text.slice(1) : "");

/**
 * The three chips: undertone ("Olive" when the detector saw it), depth, clarity. A chip is left out
 * when its value is unknown. dot: the colour of the chip's dot (the measured skin colour, or the accent).
 */
export function colourChips({ undertone, olive, depth, skinHex, palette }) {
  const roles = paletteRoles(palette);
  const accent = roles.find((c) => c.role === "Accent");
  const clarity = clarityOf(palette);
  return [
    undertone && { key: "undertone", label: olive ? "Olive" : capitalise(undertone), dot: skinHex || "#c9b49e" },
    depth && { key: "depth", label: capitalise(depth), dot: skinHex || "#a89490" },
    clarity && { key: "clarity", label: clarity, dot: accent?.hex || "#b7c1c6" },
  ].filter(Boolean);
}
