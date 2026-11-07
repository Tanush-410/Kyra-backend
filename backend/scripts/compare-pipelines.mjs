// Token comparison: the old single-photo pipeline (v1, POST /api/style-me) against the new mirror pipeline
// (v2, POST /api/v2/sessions), on the same synthetic people, through the real orchestration code of both.
// Offline and free: OpenAI is replaced by a recorder that answers like the API and reports usage.
//
// What is exact and what is modelled (see the report):
//   exact    number and kind of paid calls, prompt text and schema tokens (OpenAI's o200k tokenizer),
//            images sent and their sizes, image quality requested, response text tokens
//   modelled vision image tokens (OpenAI's tile formula), image-edit tokens (calibrated on this project's
//            real calls), reasoning tokens (0 for both, which favours the old pipeline)
//
// Usage: node scripts/compare-pipelines.mjs [cases=50] [outDir=reports/token-comparison]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encode } from 'gpt-tokenizer/encoding/o200k_base';
import sharp from 'sharp';
import { DEFAULT_PRICES, priceUsage, normaliseUsage } from '../src/lib/usage.js';
import { bundleFor, fakeSidecar, mirrorApp, waitFor, waitForRender } from '../test/mirror-helpers.js';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CASES = Number(process.argv[2]) || 50;
const OUT = path.resolve(backendRoot, process.argv[3] || 'reports/token-comparison');
mkdirSync(path.join(OUT, 'pictures'), { recursive: true });

// ---- calibration from this project's real OpenAI calls -------------------------------------------
// Total tokens of one gpt-image-1.5 edit of a 1024x1536 visitor image, measured on real calls on
// 6 Nov 2026 (seed values in src/lib/mirror.js): low 1,100 and medium 2,750. High is not measured
// here; 6,000 matches the 5 Nov report's real cost of about $0.26 per visitor at the default quality.
const IMAGE_CALL_TOTAL = { low: 1100, medium: 2750, high: 6000 };
// Output (image) tokens of a 1024x1536 image by quality (OpenAI's gpt-image token table), used only
// to split the calibrated total into input and output for pricing.
const IMAGE_OUTPUT = { low: 408, medium: 1584, high: 6240 };
const PARTIAL_IMAGE_TOKENS = 100; // OpenAI: each streamed partial image adds 100 output tokens
const MESSAGE_OVERHEAD = 8;       // role/message framing of a Responses call (approximate)
const tokens = (text) => encode(String(text ?? '')).length;

// Vision input tokens for gpt-5.2 (GPT-4o/GPT-5 tile formula, detail auto = high for photos this size):
// fit within 2048x2048, scale the short side to 768, then 85 + 170 per 512 px tile.
function visionTokens(width, height) {
  let w = width;
  let h = height;
  const fit = Math.min(1, 2048 / Math.max(w, h));
  w *= fit;
  h *= fit;
  const shrink = Math.min(1, 768 / Math.min(w, h));
  w *= shrink;
  h *= shrink;
  return 85 + 170 * Math.ceil(w / 512) * Math.ceil(h / 512);
}

// ---- synthetic people ----------------------------------------------------------------------------
function labToHex([L, a, b]) {
  const fy = (L + 16) / 116;
  const f = (t) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  const [X, Y, Z] = [0.95047 * f(fy + a / 500), f(fy), 1.08883 * f(fy - b / 200)];
  const lin = [3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z, -0.969266 * X + 1.8760108 * Y + 0.041556 * Z, 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z];
  return `#${lin.map((c) => Math.round(255 * Math.min(1, Math.max(0, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)))).map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

const PEOPLE = [
  { id: 'p01', gender: 'female', skin: [76, 8, 15], hair: '#d8b878', top: '#7d9ccf', bottom: '#2b3245', build: 0.95 },
  { id: 'p02', gender: 'male', skin: [70, 10, 19], hair: '#3a2a1e', top: '#e9e4d8', bottom: '#4a5a3a', build: 1.1 },
  { id: 'p03', gender: 'female', skin: [65, 12, 23], hair: '#1e1612', top: '#b0412f', bottom: '#1f2a44', build: 0.9 },
  { id: 'p04', gender: 'male', skin: [62, 13, 24], hair: '#2a1f18', top: '#2f4f4f', bottom: '#c2b280', build: 1.05 },
  { id: 'p05', gender: 'female', skin: [58, 14, 20], hair: '#120d0a', top: '#f2f0ea', bottom: '#6b4f3a', build: 1.0 },
  { id: 'p06', gender: 'male', skin: [55, 15, 17], hair: '#151515', top: '#3c4a8a', bottom: '#2e2e2e', build: 1.15 },
  { id: 'p07', gender: 'female', skin: [50, 15, 22], hair: '#0e0b09', top: '#d9a441', bottom: '#2a2a2a', build: 0.95 },
  { id: 'p08', gender: 'male', skin: [45, 14, 22], hair: '#0b0908', top: '#8a9a5b', bottom: '#3b3b3b', build: 1.0 },
  { id: 'p09', gender: 'female', skin: [40, 14, 20], hair: '#080605', top: '#c8a2c8', bottom: '#1c1c1c', build: 0.9 },
  { id: 'p10', gender: 'male', skin: [32, 12, 16], hair: '#050404', top: '#e07b39', bottom: '#2f3b52', build: 1.1 }
];
const CONDITIONS = [
  { id: 'webcam-1920x1080', width: 1920, height: 1080, light: [1, 1, 1], wall: '#9a9a96' },
  { id: 'kiosk-portrait-1080x1920', width: 1080, height: 1920, light: [1, 1, 1], wall: '#a8a49c' },
  { id: 'phone-3024x4032', width: 3024, height: 4032, light: [1, 1, 1], wall: '#8f969c' },
  { id: 'warm-tungsten-1920x1080', width: 1920, height: 1080, light: [1.22, 1.0, 0.72], wall: '#a39b8e' },
  { id: 'cool-led-dim-1280x720', width: 1280, height: 720, light: [0.72, 0.82, 0.98], wall: '#9aa0a6' }
];
const STYLES = ['casual', 'office', 'wedding guest', 'party', 'smart casual'];

// A standing person drawn head to toe in a room. Returns the photo and the face box (normalized).
async function drawPerson(person, condition) {
  const { width: W, height: H } = condition;
  const bodyH = H * 0.84;
  const top = H * 0.07;
  const cx = W * 0.5;
  const head = bodyH * 0.065;
  const shoulder = bodyH * 0.13 * person.build;
  const skin = labToHex(person.skin);
  const headY = top + head * 1.1;
  const neckY = headY + head;
  const hipY = top + bodyH * 0.52;
  const footY = top + bodyH;
  const eye = (dx) => `<ellipse cx="${cx + dx}" cy="${headY - head * 0.1}" rx="${head * 0.2}" ry="${head * 0.09}" fill="#f4f4f2"/><circle cx="${cx + dx}" cy="${headY - head * 0.1}" r="${head * 0.07}" fill="#3b2a20"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="100%" height="100%" fill="${condition.wall}"/>
    <rect y="${footY - bodyH * 0.02}" width="100%" height="${H - footY + bodyH * 0.02}" fill="#6d645a"/>
    <rect x="${W * 0.08}" y="${H * 0.2}" width="${W * 0.12}" height="${H * 0.25}" fill="#5f7d8c"/>
    <rect x="${cx - shoulder * 0.18}" y="${neckY - head * 0.2}" width="${shoulder * 0.36}" height="${head * 0.6}" fill="${skin}"/>
    <path d="M${cx - shoulder} ${neckY + head * 0.3} Q${cx} ${neckY - head * 0.2} ${cx + shoulder} ${neckY + head * 0.3} L${cx + shoulder * 0.8} ${hipY} L${cx - shoulder * 0.8} ${hipY} Z" fill="${person.top}"/>
    <rect x="${cx - shoulder * 1.22}" y="${neckY + head * 0.3}" width="${shoulder * 0.26}" height="${bodyH * 0.33}" rx="${shoulder * 0.1}" fill="${person.top}"/>
    <rect x="${cx + shoulder * 0.96}" y="${neckY + head * 0.3}" width="${shoulder * 0.26}" height="${bodyH * 0.33}" rx="${shoulder * 0.1}" fill="${person.top}"/>
    <circle cx="${cx - shoulder * 1.09}" cy="${neckY + head * 0.3 + bodyH * 0.35}" r="${shoulder * 0.13}" fill="${skin}"/>
    <circle cx="${cx + shoulder * 1.09}" cy="${neckY + head * 0.3 + bodyH * 0.35}" r="${shoulder * 0.13}" fill="${skin}"/>
    <rect x="${cx - shoulder * 0.78}" y="${hipY}" width="${shoulder * 0.72}" height="${footY - hipY - bodyH * 0.04}" fill="${person.bottom}"/>
    <rect x="${cx + shoulder * 0.06}" y="${hipY}" width="${shoulder * 0.72}" height="${footY - hipY - bodyH * 0.04}" fill="${person.bottom}"/>
    <ellipse cx="${cx - shoulder * 0.45}" cy="${footY - bodyH * 0.02}" rx="${shoulder * 0.45}" ry="${bodyH * 0.022}" fill="#2b2420"/>
    <ellipse cx="${cx + shoulder * 0.45}" cy="${footY - bodyH * 0.02}" rx="${shoulder * 0.45}" ry="${bodyH * 0.022}" fill="#2b2420"/>
    <ellipse cx="${cx}" cy="${headY}" rx="${head * 0.82}" ry="${head}" fill="${skin}"/>
    <path d="M${cx - head * 0.86} ${headY - head * 0.15} Q${cx} ${headY - head * 1.6} ${cx + head * 0.86} ${headY - head * 0.15} Q${cx} ${headY - head * 0.85} ${cx - head * 0.86} ${headY - head * 0.15} Z" fill="${person.hair}"/>
    ${eye(-head * 0.33)}${eye(head * 0.33)}
    <path d="M${cx - head * 0.25} ${headY + head * 0.45} Q${cx} ${headY + head * 0.6} ${cx + head * 0.25} ${headY + head * 0.45}" stroke="#7a3b35" stroke-width="${head * 0.06}" fill="none"/>
  </svg>`;
  const [r, g, b] = condition.light;
  const buffer = await sharp(Buffer.from(svg)).recomb([[r, 0, 0], [0, g, 0], [0, 0, b]]).jpeg({ quality: 90 }).toBuffer();
  const faceBox = { x: (cx - head * 0.85) / W, y: (headY - head * 1.1) / H, width: (head * 1.7) / W, height: (head * 2.2) / H };
  // What the sidecar would hand the render step: the person cropped 2:3 and scaled to 1024x1536.
  const cropH = Math.round(Math.min(H, (footY - top) / 0.9));
  const cropW = Math.min(W, Math.round((cropH * 2) / 3));
  const render = await sharp(buffer)
    .extract({ left: Math.max(0, Math.round(cx - cropW / 2)), top: Math.max(0, Math.round(Math.min(H - cropH, top - bodyH * 0.05))), width: cropW, height: cropH })
    .resize(1024, 1536, { fit: 'fill' })
    .jpeg({ quality: 92 })
    .toBuffer();
  return { buffer, faceBox, render };
}

// The skin profile the sidecar would measure for this person (undertone from hue, depth from ITA).
function measuredSkin([L, a, b]) {
  const hue = (Math.atan2(b, a) * 180) / Math.PI;
  const ita = (Math.atan((L - 50) / b) * 180) / Math.PI;
  const depth = ita > 55 ? 'fair' : ita > 41 ? 'light' : ita > 28 ? 'medium' : ita > 10 ? 'tan' : 'deep';
  return { skinUndertone: hue < 50 ? 'cool' : hue > 58 ? 'warm' : 'neutral', skinDepth: depth, confidence: 'medium', lab: { L, a, b } };
}

// ---- realistic OpenAI answers --------------------------------------------------------------------
// The old pipeline's design answer: the real gpt-5.2 output saved on 5 Nov 2026.
const REAL_V1_DESIGN = (() => {
  try {
    const dir = path.resolve(backendRoot, '..', 'How do I look', 'outfit-flow', 'suggestions');
    const file = path.join(dir, 'styled-suggestion-2026-11-05T10-46-58-273Z.json');
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    return { palette: saved.palette, outfit: saved.outfit, source: 'real 5 Nov 2026 output' };
  } catch {
    return null;
  }
})();
const V1_DESIGN = REAL_V1_DESIGN || {
  palette: [{ name: 'Navy', hex: '#1F2A44' }, { name: 'Off-white', hex: '#F2F0EA' }, { name: 'Olive', hex: '#556B2F' }],
  outfit: {
    summary: 'Clean casual layers with tapered trousers and minimalist sneakers.',
    reasoning: 'Neutral-medium colouring is flattered by balanced neutrals plus olive and navy.',
    items: [{ category: 'top', name: 'Off-white heavyweight cotton crewneck T-shirt', color: 'Off-white', hex: '#F2F0EA', fit: 'Regular fit, hip-length', material: 'Heavyweight cotton jersey' }]
  }
};
// The new pipeline's design answer: three outfits of the same detail as the real one above.
const realItems = (V1_DESIGN.outfit.items || []).map(({ category, name, color, hex, fit, material }) => ({ category, name, colorName: color, hex, fit, material }));
const V2_DESIGN = {
  options: [0, 1, 2].map((i) => ({
    title: ['Clean casual layers', 'Smart weekend', 'Relaxed tailoring'][i],
    summary: V1_DESIGN.outfit.summary,
    reasoning: V1_DESIGN.outfit.reasoning,
    items: realItems.map((item) => ({ ...item, name: i ? `${item.name} (variant ${i + 1})` : item.name }))
  }))
};
const FACE_CHECK = { samePerson: true, score: 0.92, issues: '' };

// ---- the recording OpenAI fake -------------------------------------------------------------------
let current = null; // { case, pipeline, calls: [] }
let renderImageB64 = '';

async function imageSize(dataOrBuffer) {
  const buffer = Buffer.isBuffer(dataOrBuffer) ? dataOrBuffer : Buffer.from(String(dataOrBuffer).split(',')[1], 'base64');
  const { width, height } = await sharp(buffer).metadata();
  return { width, height };
}

async function fakeOpenAI(url, init) {
  if (String(url).endsWith('/images/edits')) {
    const form = init.body;
    const prompt = form.get('prompt');
    const quality = form.get('quality') || 'auto';
    const resolved = quality === 'auto' ? AUTO_QUALITY : quality;
    const partials = form.get('stream') === 'true' ? Number(form.get('partial_images') || 0) : 0;
    const images = await Promise.all(form.getAll('image[]').map(async (blob) => imageSize(Buffer.from(await blob.arrayBuffer()))));
    const promptTokens = tokens(prompt);
    // Calibrated total (measured with the new pipeline's prompt, ~V2_RENDER_PROMPT tokens), adjusted by
    // the exact difference in prompt length; extra input images add their tile tokens.
    const extraImages = images.slice(1).reduce((sum, size) => sum + visionTokens(size.width, size.height), 0);
    const total = IMAGE_CALL_TOTAL[resolved] - V2_RENDER_PROMPT_TOKENS + promptTokens + extraImages;
    const output = IMAGE_OUTPUT[resolved] + partials * PARTIAL_IMAGE_TOKENS;
    const usage = {
      input_tokens: total - IMAGE_OUTPUT[resolved],
      input_tokens_details: { text_tokens: promptTokens, image_tokens: total - IMAGE_OUTPUT[resolved] - promptTokens },
      output_tokens: output,
      total_tokens: total - IMAGE_OUTPUT[resolved] + output
    };
    current?.calls.push({ kind: 'image_edit', quality, resolvedQuality: resolved, partialImages: partials, images, promptTokens, usage });
    return new Response(JSON.stringify({ data: [{ b64_json: renderImageB64 }], usage }), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  const body = JSON.parse(init.body);
  const content = body.input[0].content;
  const text = content.find((part) => part.type === 'input_text').text;
  const imageUrls = content.filter((part) => part.type === 'input_image').map((part) => part.image_url);
  const schema = body.text?.format?.schema;
  const kind = text.includes('photo check')
    ? 'photo_check'
    : body.text?.format?.name === 'outfit_options'
      ? 'design_3_options'
      : text.includes('Design one complete outfit')
        ? 'design_1_outfit'
        : text.includes('Judge only whether the face')
          ? 'face_check'
          : 'other';
  const answer =
    kind === 'photo_check'
      ? { usable: true, reason: '', personCount: 1, singleProminentPerson: true, fullBodyVisible: true, faceVisible: true, lighting: 'good', faceBox: current.faceBox, estimate: { skinUndertone: current.skin.skinUndertone, skinDepth: current.skin.skinDepth, heightImpression: 'average', frame: 'medium' }, currentOutfit: 'plain top and trousers' }
      : kind === 'design_3_options'
        ? V2_DESIGN
        : kind === 'design_1_outfit'
          ? V1_DESIGN
          : kind === 'face_check'
            ? FACE_CHECK
            : {};
  const outputText = JSON.stringify(answer);
  const images = await Promise.all(imageUrls.map(imageSize));
  const textTokens = tokens(text);
  const schemaTokens = schema ? tokens(JSON.stringify(schema)) : 0;
  const imageTokens = images.reduce((sum, size) => sum + visionTokens(size.width, size.height), 0);
  const usage = {
    input_tokens: textTokens + schemaTokens + MESSAGE_OVERHEAD + imageTokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: tokens(outputText),
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: textTokens + schemaTokens + MESSAGE_OVERHEAD + imageTokens + tokens(outputText)
  };
  current?.calls.push({ kind, images, promptTokens: textTokens, schemaTokens, imageTokens, outputTokens: usage.output_tokens, usage });
  return new Response(JSON.stringify({ output_text: outputText, usage }), { status: 200, headers: { 'content-type': 'application/json' } });
}

// ---- run -----------------------------------------------------------------------------------------
// The calibration was measured with the new pipeline's render prompt; its exact length is measured in a
// warm-up run below, so the new pipeline's image calls reproduce the measured totals exactly.
let V2_RENDER_PROMPT_TOKENS = 0;
const AUTO_QUALITY = 'medium';

function costOf(call) {
  const endpoint = call.kind === 'image_edit' ? 'images' : 'responses';
  const model = endpoint === 'images' ? 'gpt-image-1.5' : 'gpt-5.2';
  return priceUsage(model, endpoint, normaliseUsage(call.usage, endpoint), DEFAULT_PRICES) || 0;
}

async function runCase(app, sidecarState, testCase) {
  const results = {};
  for (const pipeline of ['old', 'new']) {
    current = { ...testCase, pipeline, calls: [] };
    const started = Date.now();
    if (pipeline === 'old') {
      const response = await app.inject({ method: 'POST', url: '/api/style-me', payload: { imageDataUrl: testCase.dataUrl, style: testCase.style, gender: testCase.gender } });
      if (response.statusCode !== 200) {
        throw new Error(`old pipeline refused ${testCase.id}: ${response.body}`);
      }
      const jobId = response.json().virtualTryOnJobId;
      await waitFor(async () => (await app.inject(`/api/virtual-tryon/${jobId}`)).json().status !== 'processing', { timeoutMs: 20_000 });
    } else {
      sidecarState.bundle = testCase.bundle;
      const response = await app.inject({ method: 'POST', url: '/api/v2/sessions', payload: { imageDataUrl: testCase.dataUrl, style: testCase.style, gender: testCase.gender, consent: true } });
      if (response.statusCode !== 201) {
        throw new Error(`new pipeline refused ${testCase.id}: ${response.body}`);
      }
      const { render } = await waitForRender(app, response.json().sessionId);
      if (render.status !== 'done') {
        throw new Error(`new pipeline render ${render.status} for ${testCase.id}`);
      }
      await app.inject({ method: 'DELETE', url: `/api/v2/sessions/${response.json().sessionId}` });
    }
    const calls = current.calls.map((call) => ({ ...call, totalTokens: call.usage.total_tokens, usd: Math.round(costOf(call) * 1e6) / 1e6 }));
    results[pipeline] = {
      calls,
      paidCalls: calls.length,
      exactPromptTokens: calls.reduce((sum, c) => sum + c.promptTokens + (c.schemaTokens || 0), 0),
      imagesSent: calls.reduce((sum, c) => sum + c.images.length, 0),
      totalTokens: calls.reduce((sum, c) => sum + c.totalTokens, 0),
      usd: Math.round(calls.reduce((sum, c) => sum + c.usd, 0) * 1e6) / 1e6,
      ms: Date.now() - started
    };
  }
  return results;
}

const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return { mean: Math.round(mean * 100) / 100, median: sorted[Math.floor(sorted.length / 2)], min: sorted[0], max: sorted.at(-1) };
};

const sidecarState = { bundle: null };
const sidecar = fakeSidecar({ bundle: () => sidecarState.bundle });
const { app } = await mirrorApp({
  openai: { fetchImpl: fakeOpenAI },
  sidecar,
  // Production defaults for everything that changes tokens (PARTIAL_IMAGES=2, FINAL_QUALITY=low,
  // FACE_CHECK=true with 1 retry, no drafts, no prefetch). Rate limit and spend cap off for the run.
  env: { PARTIAL_IMAGES: '2', FINAL_QUALITY: 'low', RENDER_DRAFT: 'false', PREFETCH_OPTIONS: 'false', FACE_CHECK: 'true', RATE_LIMIT_MAX: '0', DAILY_BUDGET_USD: '0', RETENTION_HOURS: '0' }
});

console.log(`Building ${CASES} synthetic test pictures…`);
const cases = [];
for (let i = 0; i < CASES; i += 1) {
  const person = PEOPLE[i % PEOPLE.length];
  const condition = CONDITIONS[Math.floor(i / PEOPLE.length) % CONDITIONS.length];
  const { buffer, faceBox, render } = await drawPerson(person, condition);
  const id = `t${String(i + 1).padStart(2, '0')}-${person.id}-${condition.id}`;
  writeFileSync(path.join(OUT, 'pictures', `${id}.jpg`), buffer);
  const skin = measuredSkin(person.skin);
  const bundle = await bundleFor({ skin });
  bundle.render.imageDataUrl = `data:image/jpeg;base64,${render.toString('base64')}`;
  cases.push({ id, person: person.id, condition: condition.id, style: STYLES[i % STYLES.length], gender: person.gender, faceBox, skin, bundle, dataUrl: `data:image/jpeg;base64,${buffer.toString('base64')}`, photo: `${condition.width}x${condition.height}` });
}
renderImageB64 = cases[0].bundle.render.imageDataUrl.split(',')[1];

// Warm-up (not recorded): measures the exact token length of the new pipeline's render prompt.
{
  const warm = await runCase(app, sidecarState, { ...cases[0], id: 'warm-up' });
  V2_RENDER_PROMPT_TOKENS = warm.new.calls.find((c) => c.kind === 'image_edit').promptTokens;
}

const rows = [];
for (const testCase of cases) {
  const result = await runCase(app, sidecarState, testCase);
  rows.push({ id: testCase.id, person: testCase.person, condition: testCase.condition, photo: testCase.photo, style: testCase.style, skin: testCase.skin, ...result });
  process.stdout.write(`${testCase.id}: old ${result.old.totalTokens} tokens / ${result.old.paidCalls} calls, new ${result.new.totalTokens} / ${result.new.paidCalls}\n`);
}
await app.close();

const v2PromptTokens = V2_RENDER_PROMPT_TOKENS;

const byKind = (pipeline) => {
  const out = {};
  for (const row of rows) {
    for (const call of row[pipeline].calls) {
      const entry = (out[call.kind] ||= { calls: 0, tokens: 0, usd: 0 });
      entry.calls += 1;
      entry.tokens += call.totalTokens;
      entry.usd += call.usd;
    }
  }
  for (const entry of Object.values(out)) {
    entry.tokensPerLook = Math.round(entry.tokens / rows.length);
    entry.callsPerLook = Math.round((entry.calls / rows.length) * 100) / 100;
    entry.usdPerLook = Math.round((entry.usd / rows.length) * 1e5) / 1e5;
    delete entry.usd;
  }
  return out;
};

const oldTokens = rows.map((r) => r.old.totalTokens);
const newTokens = rows.map((r) => r.new.totalTokens);
const oldHigh = rows.map((r) => {
  const image = r.old.calls.find((c) => c.kind === 'image_edit');
  return r.old.totalTokens - image.totalTokens + (IMAGE_CALL_TOTAL.high - V2_RENDER_PROMPT_TOKENS + image.promptTokens);
});
const saved = rows.map((r) => r.old.totalTokens - r.new.totalTokens);
const summary = {
  generatedAt: new Date().toISOString(),
  tests: rows.length,
  pipelines: { old: 'v1 POST /api/style-me: photo check (vision) + design (1 outfit) + image edit at quality auto + face check (vision)', new: 'v2 POST /api/v2/sessions: local perception + design (3 outfits) + image edit at quality low (2 streamed previews) + local identity check' },
  assumptions: {
    tokenizer: 'o200k_base (gpt-tokenizer), exact for prompt, schema and response text',
    visionImageTokens: 'gpt-5.2 tile formula: 85 + 170 per 512 px tile after fitting 2048 and scaling the short side to 768',
    imageEditTokens: `calibrated on this project's real gpt-image-1.5 calls: ${JSON.stringify(IMAGE_CALL_TOTAL)} total per call; +${PARTIAL_IMAGE_TOKENS} output tokens per streamed preview`,
    oldImageQualityAuto: 'resolved as medium in the headline numbers (conservative); high shown separately (matches the real $0.26/visitor of 5 Nov)',
    reasoningTokens: '0 for both (unknown offline; the old pipeline makes 3 text calls to the new one\'s 1, so this favours the old)',
    faceCheckRetries: 'none needed (face check passes); a real drift would add a second image and check to the old pipeline only',
    v2RenderPromptTokensExact: v2PromptTokens
  },
  perLook: {
    old: { tokens: stats(oldTokens), usd: stats(rows.map((r) => r.old.usd)), paidCalls: stats(rows.map((r) => r.old.paidCalls)), imagesSent: stats(rows.map((r) => r.old.imagesSent)) },
    oldIfAutoIsHigh: { tokens: stats(oldHigh) },
    new: { tokens: stats(newTokens), usd: stats(rows.map((r) => r.new.usd)), paidCalls: stats(rows.map((r) => r.new.paidCalls)), imagesSent: stats(rows.map((r) => r.new.imagesSent)) }
  },
  saving: {
    tokensPerLook: stats(saved),
    percent: Math.round((1 - newTokens.reduce((a, b) => a + b, 0) / oldTokens.reduce((a, b) => a + b, 0)) * 1000) / 10,
    percentIfAutoIsHigh: Math.round((1 - newTokens.reduce((a, b) => a + b, 0) / oldHigh.reduce((a, b) => a + b, 0)) * 1000) / 10,
    usdPercent: Math.round((1 - rows.reduce((a, r) => a + r.new.usd, 0) / rows.reduce((a, r) => a + r.old.usd, 0)) * 1000) / 10,
    newPipelineWins: rows.filter((r) => r.new.totalTokens < r.old.totalTokens).length
  },
  byCallKind: { old: byKind('old'), new: byKind('new') },
  byCondition: Object.fromEntries(
    CONDITIONS.map((condition) => {
      const subset = rows.filter((r) => r.condition === condition.id);
      return [condition.id, { tests: subset.length, oldTokens: stats(subset.map((r) => r.old.totalTokens)).mean, newTokens: stats(subset.map((r) => r.new.totalTokens)).mean }];
    })
  ),
  recordedReference: {
    note: 'Real measurements already in this project, for comparison with the modelled numbers above',
    newPipelineReadme: '1,857–1,970 tokens and about $0.028 per look (real calls, 6 Nov 2026)',
    originalPipelineReadme: '2,673 tokens and $0.060 per look (real calls)',
    report5Nov: 'about $0.26 per visitor (one text call plus one image, default quality)'
  }
};

writeFileSync(path.join(OUT, 'results.jsonl'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
writeFileSync(path.join(OUT, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
const csv = [
  'test,person,condition,photo,style,pipeline,call,quality,images,prompt_tokens_exact,total_tokens,usd',
  ...rows.flatMap((row) =>
    ['old', 'new'].flatMap((pipeline) =>
      row[pipeline].calls.map((call) =>
        [row.id, row.person, row.condition, row.photo, `"${row.style}"`, pipeline, call.kind, call.resolvedQuality || '', call.images.map((s) => `${s.width}x${s.height}`).join(' '), call.promptTokens + (call.schemaTokens || 0), call.totalTokens, call.usd].join(',')
      )
    )
  )
].join('\n');
writeFileSync(path.join(OUT, 'calls.csv'), `${csv}\n`);
console.log(`\nWrote ${path.relative(backendRoot, OUT)}/ (pictures/, results.jsonl, calls.csv, summary.json)`);
console.log(JSON.stringify({ perLook: summary.perLook, saving: summary.saving, byCallKind: summary.byCallKind }, null, 2));
