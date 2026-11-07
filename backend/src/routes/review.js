import { fileTimestamp, normalizeScore, normalizeString, parseJsonOutput } from '../lib/normalize.js';
import { readPhoto } from './photo.js';

const REVIEW_PROMPT = [
  'You are KYRA Smart Mirror\'s senior fashion stylist.',
  'Analyze this single image and evaluate only the most prominent person.',
  'Most prominent person means centered, closest, or occupying the largest visible area.',
  'Ignore everyone else in the frame.',
  'Base every point on visible evidence only: fit, color harmony, structure, grooming, accessories, proportion.',
  'Give practical advice the user can apply immediately with simple adjustments.',
  'Every "improve" point must tell the user exactly what to change in their current outfit.',
  'Include concrete alternative item suggestions in text when possible (for example: swap current top/shoes/accessory with a specific alternative style).',
  'If the person is seated or partially cropped, evaluate only what is clearly visible and avoid assumptions.',
  'Prioritize observations in this order: top, accessories, bottom, shoes (if visible).',
  'Be strict about visibility: if a region is not visible enough, mark it false and skip cards for it.',
  'Avoid vague lines like "looks nice"; every card must name a concrete item, area, or styling action.',
  'Detail text should be action-oriented and specific, suitable for overlay display.',
  'Do not mention body shape, skin tone, attractiveness, age, ethnicity, or identity judgments.',
  'Focus critique on outfit, garment fit, styling choices, and presentation only.',
  'If a region is not visible, set its visible flag to false and do not write a card for that region.',
  'Tone: direct, specific, professional, and non-generic.',
  'Return STRICT JSON only (no markdown, no prose outside JSON).',
  'Schema:',
  '{',
  '  "score": number, // 0-10',
  '  "summary": string,',
  '  "visibleRegions": {',
  '    "top": boolean,',
  '    "bottom": boolean,',
  '    "shoes": boolean,',
  '    "accessories": boolean',
  '  },',
  '  "cards": [',
  '    {',
  '      "id": string,',
  '      "kind": "works" | "improve",',
  '      "area": "top" | "bottom" | "shoes" | "accessories",',
  '      "title": string,',
  '      "detail": string',
  '    }',
  '  ]',
  '}',
  'Rules:',
  '- Return exactly 4 cards when possible; otherwise 3 cards minimum.',
  '- Prefer balanced output: 2 "works" and 2 "improve" when possible.',
  '- Keep title <= 4 words and detail <= 12 words.',
  '- Avoid repeating the same issue across multiple cards.',
  '- Use concrete language (name colors/items/areas), never generic compliments.',
  '- Prefer short actionable phrasing, for example: "Tuck shirt slightly", "Raise collar structure".',
  '- "works" cards: state why it works in this specific frame.',
  '- "improve" cards: start detail with a clear action verb when possible.',
  '- At least 1 "improve" card must include an alternative item suggestion (swap/replace recommendation).',
  '- Alternative suggestions must stay in the same item category (top for top, shoes for shoes, etc.).',
  '- Keep details camera-ready: concise enough to read quickly on-screen.',
  '- Do not include marker points, anchor coordinates, or any location fields.',
  '- Summary must be one sentence, maximum 14 words.',
  '- Summary style: neutral and specific, no hype words.',
  '- Score rubric: 8-10 polished/cohesive, 5-7 decent with clear fixes, 0-4 major issues/poor visibility.',
  '- If image is unclear/cropped, lower confidence and score conservatively.',
  '- Do not include comments in JSON.'
].join('\n');

export default async function reviewRoutes(app, { openai, storage, rateLimit }) {
  app.post('/api/outfit-review', { config: { rateLimit } }, async (request, reply) => {
    const photo = await readPhoto(request.body?.imageDataUrl);
    if (photo.error) {
      return reply.code(photo.status).send(photo.error);
    }

    let outputText;
    try {
      outputText = await openai.respond({ text: REVIEW_PROMPT, images: [photo.dataUrl], kind: 'review' });
    } catch (error) {
      request.log.error({ error: error?.message }, 'OpenAI response failed');
      return reply.code(502).send({ error: 'Failed to analyze image with GPT model.' });
    }

    const parsed = parseReviewJson(outputText);
    const timestamp = fileTimestamp();
    const imageFile = storage.saveBuffer('lookImages', `look-${timestamp}.jpg`, photo.buffer);
    const savedArtifacts = {
      imageFile,
      suggestionFile: storage.saveJson('lookSuggestions', `look-${timestamp}.json`, {
        createdAt: new Date().toISOString(),
        imageFile,
        review: parsed
      }),
      summaryFile: storage.saveText('lookSuggestions', `look-${timestamp}.txt`, parsed.summary || '')
    };

    return reply.send({
      score: parsed.score,
      summary: parsed.summary,
      visibleRegions: parsed.visibleRegions,
      cards: parsed.cards,
      working: parsed.cards.filter((card) => card.kind === 'works').map((card) => card.title),
      notWorking: parsed.cards.filter((card) => card.kind === 'improve').map((card) => card.title),
      savedArtifacts
    });
  });
}

export function parseReviewJson(text) {
  const fallbackRegions = { top: true, bottom: false, shoes: false, accessories: false };
  if (!text) {
    return {
      score: 0,
      summary: 'Could not parse AI response clearly. Please retake a clear full-body photo.',
      visibleRegions: fallbackRegions,
      cards: []
    };
  }

  try {
    const parsed = parseJsonOutput(text);
    return {
      score: normalizeScore(parsed.score),
      summary: normalizeString(parsed.summary),
      visibleRegions: {
        top: Boolean(parsed.visibleRegions?.top),
        bottom: Boolean(parsed.visibleRegions?.bottom),
        shoes: Boolean(parsed.visibleRegions?.shoes),
        accessories: Boolean(parsed.visibleRegions?.accessories)
      },
      cards: normalizeCards(parsed.cards)
    };
  } catch {
    return { score: 0, summary: text, visibleRegions: fallbackRegions, cards: [] };
  }
}

function normalizeCards(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const allowedKinds = new Set(['works', 'improve']);
  const allowedAreas = new Set(['top', 'bottom', 'shoes', 'accessories']);

  return value
    .map((entry, index) => {
      if (!allowedKinds.has(entry?.kind) || !allowedAreas.has(entry?.area)) {
        return null;
      }
      const title = normalizeString(entry?.title).slice(0, 52);
      const detail = normalizeString(entry?.detail).slice(0, 140);
      if (!title || !detail) {
        return null;
      }
      return { id: normalizeString(entry?.id) || `card-${index + 1}`, kind: entry.kind, area: entry.area, title, detail };
    })
    .filter(Boolean)
    .slice(0, 8);
}
