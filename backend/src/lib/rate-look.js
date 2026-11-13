// "Rate and changes" (Figma section "Rate and changes"): the mirror rates the outfit the visitor is wearing
// and suggests three changes (shoes, hair, jewellery by preference), each worth a few points, then renders
// the visitor in their own clothes with the changes. One structured AI call reads the photo; the code checks
// and bounds everything it returns.
import { nearestColor, NAMED_COLORS } from './colors.js';
import { promptText } from './normalize.js';

export const CHANGE_CATEGORIES = ['shoes', 'hair', 'accessory', 'bag', 'outerwear', 'top', 'bottom'];
const MAX_FINAL = 9.8;
const COLOUR_NAMES = Object.entries(NAMED_COLORS).map(([name, hex]) => ({ name: name[0].toUpperCase() + name.slice(1), hex }));

export const RATE_SCHEMA = {
  name: 'rate_look',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['score', 'summary', 'changes'],
    properties: {
      score: { type: 'number' },
      summary: { type: 'string' },
      changes: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['category', 'name', 'hex', 'why', 'tags', 'points'],
          properties: {
            category: { type: 'string', enum: CHANGE_CATEGORIES },
            name: { type: 'string' },
            hex: { type: 'string' },
            why: { type: 'string' },
            tags: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['label', 'value'],
                properties: { label: { type: 'string' }, value: { type: 'string' } }
              }
            },
            points: { type: 'number' }
          }
        }
      }
    }
  }
};

export function ratePrompt({ profile, palette = [], gender }) {
  const colours = palette.slice(0, 8).map((c) => `${c.name} ${c.hex}`).join(', ');
  const about = [
    profile?.skinUndertoneSource === 'measured' && profile?.skinUndertone && `${profile.skinUndertone} undertone`,
    profile?.skinDepth && `${profile.skinDepth} skin depth`,
    profile?.build && `${profile.build} build`,
    gender && `shops ${gender === 'female' ? "women's" : "men's"} wear`
  ].filter(Boolean).join(', ');
  return [
    'You are KYRA, a warm, expert personal stylist on a smart mirror. The photo shows a visitor in the outfit they are wearing today.',
    'Rate only the outfit and its styling (fit, colour harmony, proportions, finishing touches) from 1 to 10 with one decimal. Be honest and encouraging: most everyday outfits score 6 to 8.',
    "Never comment on the person's body, weight, face, skin, age or attractiveness.",
    'Suggest exactly 3 changes that would raise the score, each in a different category. Prefer shoes, hair and accessory (jewellery); use bag, outerwear, top or bottom only when one of those is clearly missing or the weakest part. Everything else in their outfit stays as it is.',
    'For each change:',
    "- name: the specific item or hairstyle, at most 4 words (e.g. White Kitten Heels, Soft Wave Lob, Lapis Link Necklace).",
    `- hex: its main colour as #RRGGBB, chosen to suit the visitor's palette${colours ? ` (${colours})` : ''}; for hair, the visitor's own hair colour.`,
    '- why: two short phrases separated by " | ", each at most 45 characters (e.g. Modern edge in off-white | Elevates the look with structure).',
    '- tags: 3 short facts, each a label and a value of at most 18 characters (e.g. Material / Natural PU, Type / Slingback, Fastening / Buckle).',
    '- points: how much it raises the score, 0.3 to 1.5.',
    `The score plus all points must not exceed ${MAX_FINAL}.`,
    'summary: one short sentence on what already works in the outfit.',
    about ? `About the visitor: ${about}.` : ''
  ].filter(Boolean).join('\n');
}

const round1 = (n) => Math.round(n * 10) / 10;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const short = (text, max) => promptText(text, max).replace(/[|]/g, ' ').trim();

/** Checks and bounds the model's answer. Throws when there is nothing usable. */
export function normalizeRating(raw) {
  const score = round1(clamp(Number(raw?.score) || 6.5, 1, 9.5));
  const seen = new Set();
  const changes = [];
  for (const change of Array.isArray(raw?.changes) ? raw.changes : []) {
    const category = CHANGE_CATEGORIES.includes(change?.category) ? change.category : null;
    const name = short(change?.name, 40);
    if (!category || !name || seen.has(category)) continue;
    seen.add(category);
    const hex = /^#[0-9a-f]{6}$/i.test(change.hex || '') ? change.hex.toUpperCase() : '#8A8A8A';
    const named = nearestColor(hex, COLOUR_NAMES).color;
    const why = String(change.why || '')
      .split('|')
      .map((line) => short(line, 60))
      .filter(Boolean)
      .slice(0, 2);
    const tags = (Array.isArray(change.tags) ? change.tags : [])
      .map((tag) => ({ label: short(tag?.label, 18), value: short(tag?.value, 22) }))
      .filter((tag) => tag.label && tag.value)
      .slice(0, 3);
    changes.push({ id: changes.length + 1, category, name, hex, colorName: named?.name || '', why, tags, points: round1(clamp(Number(change.points) || 0.8, 0.2, 1.5)) });
    if (changes.length === 3) break;
  }
  if (!changes.length) throw new Error('The rating had no usable changes.');
  // Keep the final score believable: scale the points down if they'd overshoot.
  const total = changes.reduce((sum, c) => sum + c.points, 0);
  const room = Math.max(0, MAX_FINAL - score);
  if (total > room) {
    for (const change of changes) change.points = round1(Math.max(0.1, (change.points * room) / total));
  }
  const finalScore = round1(Math.min(MAX_FINAL, score + changes.reduce((sum, c) => sum + c.points, 0)));
  return { score, finalScore, summary: short(raw?.summary, 160), changes };
}

/** The render's "outfit": the changes, applied to what the visitor wears (renderPrompt's keepOwn mode). */
export function changesAsOption(rating) {
  return {
    option: 1,
    title: 'Your look, elevated',
    summary: rating.summary || 'Your outfit with three finishing touches.',
    reasoning: rating.changes.map((c) => c.why.join('. ')).join(' '),
    keepOwn: true,
    items: rating.changes.map((c) => ({
      category: c.category,
      name: c.name,
      colorName: c.colorName,
      hex: c.hex,
      fit: '',
      material: c.tags.find((t) => /material|fabric|metal/i.test(t.label))?.value || ''
    }))
  };
}
