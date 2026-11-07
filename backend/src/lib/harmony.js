import { deltaE00, hexToLab, hexToRgb } from './colors.js';

// Colour harmony between the garments of one outfit, in the terms stylists use:
// - Neutrals (black, white, grey, cream, navy, denim, camel, brown, khaki, olive drab) go with anything
//   and are not counted as colours.
// - The remaining "accent" hues are compared on the painter's (RYB) colour wheel, which is what
//   complementary and triadic refer to in fashion (blue/orange, red/green, yellow/purple): same family,
//   analogous (up to 75 degrees, e.g. coral with yellow), triadic, split-complementary and complementary
//   are harmonies; two loud hues 75-100 degrees apart clash (e.g. purple with tomato red).
// - At most two accent families (three only as a triad whose third colour is an accessory).
// - 60-30-10: two loud complementary colours should not both be large garments.
// - Top and bottom either match or clearly contrast; "almost the same" reads as a mistake.
// - Shoes are neutral or echo another colour in the outfit.
// Everything runs locally; it never adds tokens.

// Share of the visible outfit per category, for the 60-30-10 rule.
const AREA = { onepiece: 0.6, top: 0.35, outerwear: 0.35, bottom: 0.3, shoes: 0.08, accessory: 0.04 };
const SAME_FAMILY = 30;
const LOUD_CHROMA = 40;
const CLASH_CHROMA = 35;
export const HARMONY_OK = 0.75;
const MAX_CHANGES = 3;

// RGB-wheel hue -> RYB-wheel hue (piecewise linear, Itten's wheel).
const RGB_TO_RYB = [[0, 0], [60, 120], [120, 180], [180, 210], [240, 240], [300, 300], [360, 360]];

function rybHue(rgb) {
  const [r, g, b] = rgb.map((v) => v / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) {
    return 0;
  }
  let hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  hue = (hue * 60 + 360) % 360;
  for (let i = 1; i < RGB_TO_RYB.length; i += 1) {
    const [x0, y0] = RGB_TO_RYB[i - 1];
    const [x1, y1] = RGB_TO_RYB[i];
    if (hue <= x1) {
      return y0 + ((hue - x0) * (y1 - y0)) / (x1 - x0);
    }
  }
  return hue;
}

export function describeColour(hex) {
  const lab = hexToLab(hex);
  const rgb = hexToRgb(hex);
  if (!lab || !rgb) {
    return null;
  }
  const chroma = Math.hypot(lab.a, lab.b);
  const labHue = (Math.atan2(lab.b, lab.a) * 180) / Math.PI;
  const hue = (labHue + 360) % 360;
  const neutral =
    chroma < 12 || // greys, black, white, taupe
    lab.L < 20 || // near-black, including the darkest navy and brown
    (lab.L > 85 && chroma < 22) || // off-white, cream, ivory
    (hue >= 240 && hue <= 300 && lab.L < 50 && chroma < 45) || // navy, denim
    (hue >= 40 && hue <= 110 && chroma < 35 && lab.L < 78); // camel, tan, khaki, brown, olive drab
  return { hex, L: lab.L, chroma, ryb: rybHue(rgb), neutral };
}

const wheelGap = (a, b) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

function relation(gap) {
  if (gap <= SAME_FAMILY) return 'monochrome';
  if (gap <= 75) return 'analogous';
  if (gap < 100) return 'clash';
  if (gap < 140) return 'triadic';
  if (gap < 165) return 'split-complementary';
  return 'complementary';
}

const areaOf = (item, items) =>
  item.category === 'top' && items.some((other) => other.category === 'outerwear') ? 0.15 : AREA[item.category] ?? 0.1;

// { score 0-1, scheme, issues[], accents[] } for an outfit's items ({ category, hex, colorName }).
export function harmony(items) {
  const described = items.map((item) => ({ item, colour: describeColour(item.hex), area: areaOf(item, items) })).filter((d) => d.colour);
  const accents = described.filter((d) => !d.colour.neutral);
  const issues = [];
  let score = 1;

  // Accent hue families: accents within SAME_FAMILY degrees of each other's family seed.
  const families = [];
  for (const accent of [...accents].sort((a, b) => b.area - a.area)) {
    const family = families.find((f) => wheelGap(f.hue, accent.colour.ryb) <= SAME_FAMILY);
    if (family) {
      family.members.push(accent);
      family.area += accent.area;
    } else {
      families.push({ hue: accent.colour.ryb, members: [accent], area: accent.area });
    }
  }

  const pairs = [];
  for (let i = 0; i < families.length; i += 1) {
    for (let j = i + 1; j < families.length; j += 1) {
      const [a, b] = [families[i], families[j]];
      const kind = relation(wheelGap(a.hue, b.hue));
      // Only two strong colours can clash; a muted one sits back like a neutral.
      const muted = [a, b].some((f) => f.members.every((m) => m.colour.chroma < CLASH_CHROMA));
      pairs.push({ a, b, kind: kind === 'clash' && muted ? 'soft contrast' : kind });
    }
  }
  for (const pair of pairs.filter((p) => p.kind === 'clash')) {
    score -= 0.35;
    issues.push(`${pair.a.members[0].item.colorName} and ${pair.b.members[0].item.colorName} clash`);
  }
  const triad = families.length === 3 && pairs.every((p) => p.kind === 'triadic') && families[2].area <= AREA.accessory;
  if (families.length > 3 || (families.length === 3 && !triad)) {
    score -= 0.25;
    issues.push(`${families.length} accent colours; keep to two plus neutrals`);
  }
  for (const pair of pairs.filter((p) => p.kind === 'complementary' || p.kind === 'split-complementary')) {
    const loud = (f) => f.area >= 0.25 && f.members.some((m) => m.colour.chroma >= LOUD_CHROMA);
    if (loud(pair.a) && loud(pair.b)) {
      score -= 0.15;
      issues.push(`${pair.a.members[0].item.colorName} and ${pair.b.members[0].item.colorName} are both loud; one should be a small accent`);
    }
  }

  // Top and bottom: match, or contrast clearly.
  const top = described.find((d) => d.item.category === 'top' || d.item.category === 'onepiece');
  const bottom = described.find((d) => d.item.category === 'bottom');
  if (top && bottom) {
    const difference = deltaE00(top.item.hex, bottom.item.hex);
    if (difference > 2.5 && difference < 10 && Math.abs(top.colour.L - bottom.colour.L) < 8) {
      score -= 0.2;
      issues.push(`${top.item.colorName} top and ${bottom.item.colorName} bottom almost match`);
    }
  }

  // Shoes: neutral, or echoing another garment's colour.
  const shoes = described.find((d) => d.item.category === 'shoes');
  if (shoes && !shoes.colour.neutral) {
    const echoed = described.some((d) => d !== shoes && deltaE00(d.item.hex, shoes.item.hex) < 15);
    if (!echoed) {
      score -= 0.1;
      issues.push(`${shoes.item.colorName} shoes do not tie in`);
    }
  }

  const kinds = pairs.map((p) => p.kind).filter((k) => k !== 'clash');
  const scheme =
    issues.some((i) => i.includes('clash'))
      ? 'clashing'
      : !families.length
        ? 'neutral'
        : families.length === 1
          ? families[0].members.length > 1 ? 'tonal' : 'neutral + accent'
          : triad ? 'triadic' : kinds[0] || 'soft contrast';
  return {
    score: Math.max(0, Math.round(score * 100) / 100),
    scheme,
    issues,
    accents: families.map((f) => f.members[0].item.colorName)
  };
}

// Fixes an outfit whose colours do not go together: recolours the smallest garments first (accessory,
// shoes, then the main pieces), each to the palette colour that improves harmony most while staying
// closest to the designer's choice. Returns the option with `harmony` set and changed items marked.
export function harmonise(option, allowedColors) {
  let items = option.items.map((item) => ({ ...item }));
  let result = harmony(items);
  const changed = new Set();
  const order = [...items.keys()].sort((a, b) => areaOf(items[a], items) - areaOf(items[b], items));

  for (let step = 0; step < MAX_CHANGES && result.score < HARMONY_OK; step += 1) {
    let best = null;
    for (const index of order) {
      if (changed.has(index)) {
        continue;
      }
      for (const colour of allowedColors) {
        if (colour.hex === items[index].hex) {
          continue;
        }
        const trial = items.map((item, i) => (i === index ? { ...item, colorName: colour.name, hex: colour.hex } : item));
        const trialResult = harmony(trial);
        // Gain in harmony first; among equal gains, the smaller garment and the closer colour.
        const gain = trialResult.score - result.score;
        const cost = deltaE00(items[index].hex, colour.hex) / 100 + areaOf(items[index], items);
        if (gain > 1e-9 && (!best || gain > best.gain + 1e-9 || (Math.abs(gain - best.gain) < 1e-9 && cost < best.cost))) {
          best = { index, colour, gain, cost, result: trialResult };
        }
      }
    }
    if (!best) {
      break;
    }
    items[best.index] = { ...items[best.index], colorName: best.colour.name, hex: best.colour.hex, harmonised: true };
    changed.add(best.index);
    result = best.result;
  }
  return { ...option, items, harmony: result };
}
