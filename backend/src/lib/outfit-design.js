import { matchesAvoided, NAMED_COLORS, nearestColor } from './colors.js';
import { harmonise } from './harmony.js';
import { normalizeString } from './normalize.js';

export const OPTION_COUNT = 3;
const CATEGORIES = ['top', 'bottom', 'onepiece', 'outerwear', 'shoes', 'accessory'];
const SNAP_REPORT_DISTANCE = 10;

const OPTIONS_SCHEMA = {
  name: 'outfit_options',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['options'],
    properties: {
      options: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'summary', 'reasoning', 'items'],
          properties: {
            title: { type: 'string' },
            summary: { type: 'string' },
            reasoning: { type: 'string' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                // No colour name: the code names each colour from the palette (enforceDesign), so writing it cost ~80 tokens for nothing.
                required: ['category', 'name', 'hex', 'fit', 'material'],
                properties: {
                  category: { type: 'string', enum: CATEGORIES },
                  name: { type: 'string' },
                  hex: { type: 'string' },
                  fit: { type: 'string' },
                  material: { type: 'string' }
                }
              }
            }
          }
        }
      }
    }
  }
};

// Complete JSON objects inside the top-level "options" array of a partial JSON string.
export function completeOptionObjects(text) {
  const start = text.indexOf('[', text.indexOf('"options"'));
  if (start < 0) {
    return [];
  }
  const objects = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let objectStart = -1;
  for (let i = start + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) {
        objectStart = i;
      }
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && objectStart >= 0) {
        objects.push(text.slice(objectStart, i + 1));
        objectStart = -1;
      }
    } else if (ch === ']' && depth === 0) {
      break;
    }
  }
  return objects;
}

// onOption(option) fires as soon as each option is complete in the stream, so rendering can start
// before the model has finished writing the other options.
export async function designOptions({ openai, request, onOption, onUsage }) {
  const { style, gender, profile, palette, fitLines, preferences, previous, feedback, hints } = request;
  const colorList = (colors) => colors.map((color) => `${color.name} ${color.hex}`).join(', ');

  // Kept short on purpose: every token here and in the answer counts against the per-look budget.
  const person = [
    `${profile.olive ? 'olive ' : ''}${profile.skinUndertone || 'neutral'} undertone${profile.skinDepth ? `, ${profile.skinDepth} skin` : ''}`,
    profile.heightCm ? `${profile.heightCm} cm` : profile.heightImpression,
    profile.build && `${profile.build} build`,
    gender
  ]
    .filter(Boolean)
    .join(', ');
  const text = [
    `Smart-mirror stylist. ${OPTION_COUNT} distinct outfits for "${style}". Person: ${person}.`,
    `Colours (use only these hex codes): ${colorList(palette.palette)}; neutrals ${colorList(palette.neutrals)}.`,
    hints?.liked.length ? `Liked by similar visitors: ${hints.liked.join(', ')}; favour in option 1.` : '',
    hints?.lessLiked.length ? `Less liked: ${hints.lessLiked.join(', ')}.` : '',
    ...fitLines,
    [preferences.season, preferences.weather].filter(Boolean).join(', '),
    preferences.modesty !== 'standard' ? `Coverage: ${preferences.modesty.replace('-', ' ')}, shoulders and knees covered.` : '',
    preferences.budget ? `Budget: ${preferences.budget}.` : '',
    preferences.avoidColors.length ? `Avoid: ${preferences.avoidColors.join(', ')}.` : '',
    previous.length ? `Already shown, do not repeat: ${previous.join(' | ')}` : '',
    feedback ? `Feedback: "${feedback}".` : '',
    'Colour harmony: neutrals plus 1-2 related accent hues (analogous or complementary), 60-30-10; shoes neutral or echoing.',
    'Each: top+bottom or onepiece, plus shoes; outerwear/accessory only if needed. Garment names specific, max 4 words; fit and material one word each. title max 3 words, summary max 10 words, reasoning max 12 words. No comments on looks, weight, age or ethnicity.'
  ]
    .filter(Boolean)
    .join('\n');

  const options = [];
  let seen = 0;
  const take = (objects) => {
    for (const raw of objects.slice(seen)) {
      seen += 1;
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      const [option] = enforceDesign([parsed], palette.allowed, preferences.avoidColors);
      if (option && options.length < OPTION_COUNT) {
        option.option = options.length + 1;
        options.push(option);
        onOption?.(option);
      }
    }
  };

  const full = await openai.respondStream({ text, schema: OPTIONS_SCHEMA, kind: 'design', onUsage, onText: (soFar) => take(completeOptionObjects(soFar)) });
  take(completeOptionObjects(full));
  if (!options.length) {
    throw new Error('Outfit design returned no usable options.');
  }
  return options;
}

// Colour words that may appear in a garment name. When the item's colour is changed (palette snap or
// harmony fix) a name like "Cobalt tux jacket" must not keep contradicting the colour sent to the image model.
const COLOUR_WORDS = new Set([
  ...Object.keys(NAMED_COLORS),
  ...'cobalt ruby emerald sapphire ivory crimson scarlet indigo mint sage rust camel tan wine plum lilac magenta fuchsia turquoise aqua cyan bronze copper champagne blush rose taupe stone sand mocha espresso chocolate forest jade teal coral peach ochre oxblood cognac midnight raspberry berry cream terracotta lavender periwinkle eggplant mauve'.split(' ')
]);
const SHADE_WORDS = new Set(['light', 'dark', 'deep', 'pale', 'bright', 'dusty', 'soft', 'rich', 'royal', 'warm', 'cool', 'muted']);

export function nameForColour(name, colorName) {
  const own = new Set(String(colorName).toLowerCase().split(/[\s-]+/));
  const words = String(name).split(/\s+/);
  const kept = words.filter((word, i) => {
    const w = word.toLowerCase().replace(/[^a-z-]/g, '');
    const parts = w.split('-');
    if (parts.some((part) => COLOUR_WORDS.has(part)) && !parts.some((part) => own.has(part))) {
      return false;
    }
    const next = (words[i + 1] || '').toLowerCase().replace(/[^a-z]/g, '');
    return !(SHADE_WORDS.has(w) && COLOUR_WORDS.has(next) && !own.has(next));
  });
  const result = kept.join(' ');
  return result ? result[0].toUpperCase() + result.slice(1) : name;
}

// Keeps colour choices inside the palette no matter what the model wrote: each item snaps to the
// nearest allowed colour (CIEDE2000), and allowed colours already exclude anything the visitor wants to
// avoid. Then the outfit's colours are checked against each other (harmony.js) and fixed if they clash.
export function enforceDesign(rawOptions, allowedColors, avoidTerms = []) {
  const allowed = allowedColors.filter((color) => !matchesAvoided(color, avoidTerms));
  if (!Array.isArray(rawOptions) || !allowed.length) {
    return [];
  }

  return rawOptions
    .map((option, index) => {
      const items = (Array.isArray(option?.items) ? option.items : [])
        .filter((item) => CATEGORIES.includes(item?.category) && normalizeString(item?.name))
        .slice(0, 6)
        .map((item) => {
          const { color, distance } = nearestColor(normalizeString(item.hex) || '#808080', allowed);
          return {
            category: item.category,
            name: normalizeString(item.name).slice(0, 80),
            colorName: color.name,
            hex: color.hex,
            fit: normalizeString(item.fit).slice(0, 40),
            material: normalizeString(item.material).slice(0, 40),
            ...(distance > SNAP_REPORT_DISTANCE ? { recoloured: true } : {})
          };
        });
      const hasBody = items.some((item) => item.category === 'onepiece') || ['top', 'bottom'].every((c) => items.some((item) => item.category === c));
      if (!hasBody) {
        return null;
      }
      return withColourNames(harmonise({
        option: index + 1,
        title: normalizeString(option.title).slice(0, 40) || `Option ${index + 1}`,
        summary: normalizeString(option.summary).slice(0, 160),
        reasoning: normalizeString(option.reasoning).slice(0, 300),
        items
      }, allowed));
    })
    .filter(Boolean)
    .slice(0, OPTION_COUNT)
    .map((option, index) => ({ ...option, option: index + 1 }));
}

const TEMPLATES = {
  formal: {
    male: [['top', 'Crisp poplin dress shirt', 'cotton'], ['outerwear', 'Tailored two-button blazer', 'wool'], ['bottom', 'Tailored trousers', 'wool'], ['shoes', 'Leather oxford shoes', 'leather']],
    female: [['onepiece', 'Tailored midi sheath dress', 'crepe'], ['outerwear', 'Fitted blazer', 'wool'], ['shoes', 'Pointed block-heel pumps', 'leather']]
  },
  party: {
    male: [['top', 'Silky camp-collar shirt', 'viscose'], ['bottom', 'Slim tapered trousers', 'wool blend'], ['shoes', 'Suede loafers', 'suede']],
    female: [['onepiece', 'Satin slip midi dress', 'satin'], ['outerwear', 'Cropped tailored jacket', 'crepe'], ['shoes', 'Strappy heeled sandals', 'leather']]
  },
  smart: {
    male: [['top', 'Knit polo shirt', 'cotton knit'], ['outerwear', 'Unstructured blazer', 'linen blend'], ['bottom', 'Straight chinos', 'cotton twill'], ['shoes', 'Leather loafers', 'leather']],
    female: [['top', 'Silk-blend shell top', 'silk blend'], ['outerwear', 'Relaxed blazer', 'linen blend'], ['bottom', 'High-rise wide-leg trousers', 'crepe'], ['shoes', 'Leather loafers', 'leather']]
  },
  casual: {
    male: [['top', 'Heavyweight crew-neck tee', 'cotton'], ['outerwear', 'Overshirt', 'cotton twill'], ['bottom', 'Straight-leg jeans', 'denim'], ['shoes', 'Clean leather sneakers', 'leather']],
    female: [['top', 'Relaxed cotton shirt', 'cotton'], ['bottom', 'High-rise straight jeans', 'denim'], ['outerwear', 'Light knit cardigan', 'cotton knit'], ['shoes', 'Clean leather sneakers', 'leather']]
  }
};

function templateFor(style) {
  const value = String(style || '').toLowerCase();
  if (/formal|wedding|gala|black tie|interview|suit/.test(value)) {
    return 'formal';
  }
  if (/party|date|night|cocktail|club|festive/.test(value)) {
    return 'party';
  }
  if (/smart|office|work|business|meeting/.test(value)) {
    return 'smart';
  }
  return 'casual';
}

// Rule-based options used when the AI designer is unavailable (outage or budget cap).
export function fallbackOptions({ style, gender, palette, preferences }) {
  const allowed = palette.allowed.filter((color) => !matchesAvoided(color, preferences.avoidColors));
  const main = allowed.filter((color) => palette.palette.some((p) => p.hex === color.hex));
  const neutrals = allowed.filter((color) => !main.includes(color));
  const pool = main.length ? main : allowed;
  const base = neutrals.length ? neutrals : allowed;
  if (!pool.length) {
    return [];
  }

  const template = TEMPLATES[templateFor(style)][gender === 'female' ? 'female' : 'male'];
  return Array.from({ length: OPTION_COUNT }, (_, index) => {
    const accent = pool[index % pool.length];
    const neutral = base[index % base.length];
    const items = template.map(([category, name, material], itemIndex) => {
      const color = category === 'top' || category === 'onepiece' ? accent : itemIndex % 2 ? neutral : base[(index + 1) % base.length];
      return { category, name, colorName: color.name, hex: color.hex, fit: 'regular', material };
    });
    return harmonise({
      option: index + 1,
      title: `${accent.name} ${templateFor(style)}`,
      summary: `${accent.name} ${items[0].name.toLowerCase()} with ${neutral.name.toLowerCase()} basics.`,
      reasoning: `${accent.name} comes from the palette matched to the measured skin tone.`,
      items
    }, allowed);
  });
}

// Item names agree with the colour actually used.
function withColourNames(option) {
  return { ...option, items: option.items.map((item) => ({ ...item, name: nameForColour(item.name, item.colorName) })) };
}
