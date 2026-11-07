import { matchesAvoided } from './colors.js';

// Rule-based colour palettes in the spirit of seasonal colour analysis: undertone picks the colour
// temperature, skin depth picks the value and contrast. The same measured profile always gets the
// same palette, and the LLM only chooses garments within it.
const PALETTES = {
  warm: {
    light: [
      ['Peach', '#F4B796'], ['Coral', '#F0806A'], ['Camel', '#C19A6B'], ['Warm ivory', '#F3E9D2'],
      ['Golden yellow', '#E8B83A'], ['Light olive', '#9AA05A'], ['Warm turquoise', '#3FB7A9']
    ],
    medium: [
      ['Terracotta', '#C8664A'], ['Olive', '#6B7036'], ['Mustard', '#C9A227'], ['Rust', '#A8471E'],
      ['Teal', '#1E7A73'], ['Cream', '#EFE3C6'], ['Chocolate', '#5A3A24']
    ],
    deep: [
      ['Burnt orange', '#C25A1C'], ['Olive', '#5E6630'], ['Gold', '#C9A227'], ['Deep teal', '#145C58'],
      ['Chocolate', '#4A2E1C'], ['Cream', '#EFE3C6'], ['Tomato red', '#C8361F']
    ]
  },
  cool: {
    light: [
      ['Soft pink', '#E8B4C4'], ['Lavender', '#B8A6D9'], ['Powder blue', '#A9C6E8'], ['Berry', '#8E2F5A'],
      ['Mint', '#A8DCC8'], ['Cool grey', '#9AA3AD'], ['Navy', '#1F2A4A']
    ],
    medium: [
      ['Sapphire', '#1F4E9E'], ['Emerald', '#1B7F5B'], ['Raspberry', '#B0285C'], ['Plum', '#5E2B5C'],
      ['Navy', '#1B2A4A'], ['Cool grey', '#8E97A3'], ['Pure white', '#FAFAFA']
    ],
    deep: [
      ['Cobalt', '#1E4FC2'], ['Fuchsia', '#C2186B'], ['Emerald', '#0F7A52'], ['Royal purple', '#5B2A8C'],
      ['Ruby', '#9B111E'], ['Bright white', '#FFFFFF'], ['Charcoal', '#2F343B']
    ]
  },
  neutral: {
    light: [
      ['Dusty rose', '#D4A5A5'], ['Soft teal', '#6FA8A0'], ['Taupe', '#A8998A'], ['Jade', '#4F9A80'],
      ['Periwinkle', '#8C9ED6'], ['Off-white', '#F4F1EA'], ['Navy', '#22304F']
    ],
    medium: [
      ['Teal', '#2A7F7A'], ['Dusty blue', '#6A88A8'], ['Rose', '#C27A86'], ['Jade', '#3F8F72'],
      ['Soft plum', '#7A4A6E'], ['Taupe', '#8F8273'], ['Off-white', '#F2EFE8']
    ],
    deep: [
      ['Deep teal', '#165E5A'], ['Burgundy', '#6D1B2A'], ['Jade', '#2F7D62'], ['Eggplant', '#4A2445'],
      ['Mid blue', '#2E5C9A'], ['Charcoal', '#33383F'], ['Soft white', '#F3F1EC']
    ]
  },
  // From the undertone detector's olive palette (vendor/undertone/data/palette.json, Lab -> sRGB):
  // olive skin has a green-yellow cast that earthy greens, plums, burgundies and bronzes flatter.
  olive: {
    light: [
      ['Pale sage', '#AEBB9C'], ['Moss gold', '#AFA76B'], ['Dusty rose', '#CAA29D'], ['Muted jade', '#759F8C'],
      ['Slate teal', '#688D89'], ['Antique bronze', '#AB8B60'], ['Soft plum', '#9B778C']
    ],
    medium: [
      ['Deep olive', '#7A8051'], ['Terracotta', '#C47050'], ['Forest green', '#467758'], ['Rich plum', '#8D5873'],
      ['Burgundy', '#9E484B'], ['Ochre', '#CAA045'], ['Warm navy', '#3A4C6A']
    ],
    deep: [
      ['Dark emerald', '#216B46'], ['Burnt copper', '#AB5D32'], ['Deep fig', '#6E4357'], ['Rich bronze', '#8C5E33'],
      ['Dark teal', '#306163'], ['Spiced mustard', '#AE8C3D'], ['Ruby', '#A22F3F']
    ]
  }
};

const NEUTRALS = {
  warm: [['Camel', '#C19A6B'], ['Cream', '#EFE3C6'], ['Chocolate', '#4E3423'], ['Navy', '#1F2A44'], ['Denim', '#4A6A8E'], ['Stone', '#B8AE9C']],
  cool: [['White', '#F7F7F7'], ['Charcoal', '#33383F'], ['Black', '#141414'], ['Navy', '#1B2A4A'], ['Grey', '#8A9099'], ['Denim', '#40618A']],
  neutral: [['Off-white', '#F2EFE8'], ['Taupe', '#8F8273'], ['Navy', '#22304F'], ['Grey', '#8C8C8C'], ['Denim', '#46658A'], ['Black', '#1A1A1A']],
  olive: [['Soft cream', '#E7E3CF'], ['Espresso', '#523729'], ['Warm navy', '#3A4C6A'], ['Stone', '#B8AE9C'], ['Denim', '#46658A'], ['Charcoal', '#33383F']]
};

function depthGroup(depth) {
  return depth === 'fair' || depth === 'light' ? 'light' : depth === 'tan' || depth === 'deep' ? 'deep' : 'medium';
}

const toColors = (pairs) => pairs.map(([name, hex]) => ({ name, hex }));

// scores: optional { colourName: { score } } learned from likes; the palette is then ordered so
// the colours people with this undertone liked come first (unrated colours sit at a neutral 0.5).
// olive: the undertone detector found a clear green-yellow offset; it gets its own palette.
export function buildPalette({ skinUndertone, skinDepth, skinUndertoneSource, olive }, avoidTerms = [], scores = null) {
  const undertone = olive ? 'olive' : PALETTES[skinUndertone] ? skinUndertone : 'neutral';
  const group = depthGroup(skinDepth);
  const keep = (color) => !matchesAvoided(color, avoidTerms);
  const learned = (color) => scores?.[color.name]?.score ?? 0.5;

  const palette = toColors(PALETTES[undertone][group]).filter(keep);
  if (scores) {
    palette.sort((a, b) => learned(b) - learned(a));
  }
  const neutrals = toColors(NEUTRALS[undertone]).filter(keep);
  return {
    basis: { undertone, depthGroup: group, assumed: !PALETTES[skinUndertone] || skinUndertoneSource === 'fallback', learned: Boolean(scores) },
    palette,
    neutrals,
    allowed: [...palette, ...neutrals.filter((n) => !palette.some((p) => p.hex === n.hex))]
  };
}

// Mean learned like-rate of an option's colours; used to order options 2 and 3.
export function optionScore(option, scores) {
  if (!scores) {
    return 0.5;
  }
  const values = option.items.map((item) => scores[item.colorName]?.score ?? 0.5);
  return values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
}

// Up to three most- and least-liked colours with enough votes, to steer the designer.
export function learnedHints(scores, minVotes = 3) {
  if (!scores) {
    return null;
  }
  const rated = Object.entries(scores).filter(([, s]) => s.up + s.down >= minVotes).sort((a, b) => b[1].score - a[1].score);
  if (!rated.length) {
    return null;
  }
  return {
    liked: rated.filter(([, s]) => s.score > 0.55).slice(0, 3).map(([name]) => name),
    lessLiked: rated.filter(([, s]) => s.score < 0.45).slice(-3).map(([name]) => name)
  };
}

// Cut and proportion rules from height and build, passed to the designer as constraints.
export function fitGuidance({ heightImpression, build }) {
  const lines = [];
  if (heightImpression === 'petite') {
    lines.push('Petite: high-rise bottoms, cropped or waist-length jackets, tonal or monochrome looks, avoid oversized lengths.');
  } else if (heightImpression === 'tall') {
    lines.push('Tall: longer lengths, layering, wide-leg or full-length trousers, colour blocking between top and bottom works well.');
  }
  if (build === 'slim') {
    lines.push('Slim build: layers and textured fabrics add dimension; structured shoulders and straight cuts.');
  } else if (build === 'broad') {
    lines.push('Broad build: V-necks and open collars, vertical lines, structured but not tight fits, avoid heavy shoulder details.');
  }
  return lines;
}
