// Colour roles for a palette (Core, Core, Supporting, Supporting, Accent) and its clarity (Clear or Soft),
// worked out from the colours themselves. The same rules as the kiosk's Skin Tone card
// (Kyra-UI-V1/src/lib/colourRoles.js), so the phone page and the mirror agree.

/** sRGB hex -> CIELAB (D65). */
export function hexToLab(hex) {
  const clean = String(hex || '').replace('#', '');
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

/** Mean chroma at or above this reads as 'Clear'; below, 'Soft'. */
export const CLEAR_CHROMA = 32;

/** [{ name, hex, role }] in display order: Core, Core, Supporting, Supporting, Accent. */
export function paletteRoles(palette = []) {
  const five = palette.filter((c) => hexToLab(c?.hex)).slice(0, 5);
  if (five.length < 3) return five.map((c) => ({ ...c, role: 'Core' }));
  const byChroma = [...five].sort((a, b) => chromaOf(a.hex) - chromaOf(b.hex));
  const accent = byChroma[byChroma.length - 1];
  const core = byChroma.slice(0, 2);
  const supporting = five.filter((c) => c !== accent && !core.includes(c));
  return [
    ...core.map((c) => ({ ...c, role: 'Core' })),
    ...supporting.map((c) => ({ ...c, role: 'Supporting' })),
    { ...accent, role: 'Accent' },
  ];
}

export function clarityOf(palette = []) {
  const five = palette.filter((c) => hexToLab(c?.hex)).slice(0, 5);
  if (!five.length) return null;
  const mean = five.reduce((sum, c) => sum + chromaOf(c.hex), 0) / five.length;
  return mean >= CLEAR_CHROMA ? 'Clear' : 'Soft';
}

