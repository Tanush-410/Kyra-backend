import { rgbToLab } from './image-analysis.js';

export function hexToRgb(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!match) {
    return null;
  }
  const value = parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export function hexToLab(hex) {
  const rgb = hexToRgb(hex);
  return rgb ? rgbToLab(...rgb) : null;
}

// CIE76 colour difference: ~2 is barely noticeable, >10 clearly different colours.
export function deltaE(hexA, hexB) {
  const a = hexToLab(hexA);
  const b = hexToLab(hexB);
  if (!a || !b) {
    return Infinity;
  }
  return Math.hypot(a.L - b.L, a.a - b.a, a.b - b.b);
}

// CIEDE2000 (Sharma et al.): CIELAB distance weighted the way eyes see lightness, chroma and hue.
// ~1 is the smallest visible difference. Used to match garments to the palette, as the undertone brief asks.
export function deltaE00(hexA, hexB) {
  const x = hexToLab(hexA);
  const y = hexToLab(hexB);
  return x && y ? deltaE00Lab(x, y) : Infinity;
}

export function deltaE00Lab(x, y) {
  const rad = Math.PI / 180;
  const c1 = Math.hypot(x.a, x.b);
  const c2 = Math.hypot(y.a, y.b);
  const cBar7 = ((c1 + c2) / 2) ** 7;
  const g = 0.5 * (1 - Math.sqrt(cBar7 / (cBar7 + 25 ** 7)));
  const a1 = (1 + g) * x.a;
  const a2 = (1 + g) * y.a;
  const c1p = Math.hypot(a1, x.b);
  const c2p = Math.hypot(a2, y.b);
  const hue = (b, a) => (a === 0 && b === 0 ? 0 : ((Math.atan2(b, a) / rad) + 360) % 360);
  const h1 = hue(x.b, a1);
  const h2 = hue(y.b, a2);
  let dh = h2 - h1;
  if (c1p * c2p === 0) dh = 0;
  else if (dh > 180) dh -= 360;
  else if (dh < -180) dh += 360;
  const dL = y.L - x.L;
  const dC = c2p - c1p;
  const dH = 2 * Math.sqrt(c1p * c2p) * Math.sin((dh / 2) * rad);
  const lBar = (x.L + y.L) / 2;
  const cBarP = (c1p + c2p) / 2;
  let hBar = h1 + h2;
  if (c1p * c2p !== 0) hBar = Math.abs(h1 - h2) <= 180 ? hBar / 2 : hBar < 360 ? (hBar + 360) / 2 : (hBar - 360) / 2;
  const t = 1 - 0.17 * Math.cos((hBar - 30) * rad) + 0.24 * Math.cos(2 * hBar * rad) + 0.32 * Math.cos((3 * hBar + 6) * rad) - 0.2 * Math.cos((4 * hBar - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hBar - 275) / 25) ** 2));
  const rc = 2 * Math.sqrt(cBarP ** 7 / (cBarP ** 7 + 25 ** 7));
  const sl = 1 + (0.015 * (lBar - 50) ** 2) / Math.sqrt(20 + (lBar - 50) ** 2);
  const sc = 1 + 0.045 * cBarP;
  const sh = 1 + 0.015 * cBarP * t;
  const rt = -Math.sin(2 * dTheta * rad) * rc;
  return Math.sqrt((dL / sl) ** 2 + (dC / sc) ** 2 + (dH / sh) ** 2 + rt * (dC / sc) * (dH / sh));
}

export function nearestColor(hex, colors) {
  let best = null;
  let bestDistance = Infinity;
  for (const color of colors) {
    const distance = deltaE00(hex, color.hex);
    if (distance < bestDistance) {
      best = color;
      bestDistance = distance;
    }
  }
  return { color: best, distance: bestDistance };
}

// Reference hues for matching a visitor's "avoid" words against palette colours.
export const NAMED_COLORS = {
  black: '#111111',
  white: '#F7F7F5',
  grey: '#8A8A8A',
  gray: '#8A8A8A',
  red: '#C62828',
  pink: '#E91E63',
  orange: '#EF6C00',
  yellow: '#FBC02D',
  mustard: '#C9A227',
  gold: '#C9A227',
  green: '#2E7D32',
  olive: '#6B6B2A',
  teal: '#00796B',
  blue: '#1565C0',
  navy: '#1B2A4A',
  purple: '#6A1B9A',
  lavender: '#B39DDB',
  brown: '#5D4037',
  beige: '#D8C8A8',
  cream: '#F1E6C8',
  burgundy: '#6D1B2A',
  maroon: '#6D1B2A',
  coral: '#F0806A',
  peach: '#F4B796',
  khaki: '#B9A979',
  denim: '#4A6A8E',
  silver: '#B8BCC0',
  charcoal: '#36454F'
};

const AVOID_DISTANCE = 18;

export function matchesAvoided(color, avoidTerms) {
  const name = String(color.name || '').toLowerCase();
  return avoidTerms.some((term) => {
    const word = String(term || '').trim().toLowerCase();
    if (!word) {
      return false;
    }
    if (name.includes(word)) {
      return true;
    }
    const reference = NAMED_COLORS[word] || (hexToRgb(word) ? word : null);
    return reference ? deltaE(color.hex, reference) < AVOID_DISTANCE : false;
  });
}
