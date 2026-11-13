// Rate and changes (lib/rate-look.js, mirror rate mode, routes/context.js).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeRating, ratePrompt } from '../src/lib/rate-look.js';
import { tempDir } from './helpers.js';
import { bundleFor, fakeSidecar, generatedImage, mirrorApp, waitFor } from './mirror-helpers.js';

const RATING = {
  score: 7,
  summary: 'Clean lines and a calm palette.',
  changes: [
    { category: 'shoes', name: 'White Kitten Heels', hex: '#F2EFE8', why: 'Modern edge in off-white | Elevates the look with structure', tags: [{ label: 'Material', value: 'Natural PU' }, { label: 'Type', value: 'Slingback' }, { label: 'Fastening', value: 'Buckle' }], points: 1 },
    { category: 'hair', name: 'Soft Wave Lob', hex: '#3B2A20', why: 'Adds movement | Frames the neckline', tags: [{ label: 'Length', value: 'Collarbone' }], points: 1 },
    { category: 'accessory', name: 'Lapis Link Necklace', hex: '#C9A227', why: 'Rich lapis tones | Timeless sophistication', tags: [{ label: 'Material', value: 'Gold-tone brass' }], points: 0.6 }
  ]
};

function openaiFake() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith('/images/edits')) {
      const prompt = (await new Request('http://x', { method: 'POST', body: init.body }).formData()).get('prompt');
      calls.push({ kind: 'render', prompt });
      return new Response(JSON.stringify({ data: [{ b64_json: await generatedImage() }] }), { status: 200 });
    }
    if (String(url).endsWith('/images/generations')) {
      calls.push({ kind: 'photo', prompt: JSON.parse(init.body).prompt });
      return new Response(JSON.stringify({ data: [{ b64_json: await generatedImage() }] }), { status: 200 });
    }
    const body = JSON.parse(init.body);
    const text = body.input?.[0]?.content?.[0]?.text || '';
    const rating = /Rate only the outfit/.test(text);
    calls.push({ kind: rating ? 'rate' : 'design', text, images: body.input?.[0]?.content?.filter((c) => c.type === 'input_image').length });
    return new Response(JSON.stringify({ output_text: JSON.stringify(rating ? RATING : { options: [] }) }), { status: 200 });
  };
  return { fetchImpl, calls };
}

test('the rating is checked and bounded: three different categories, believable scores', () => {
  const rating = normalizeRating({ ...RATING, changes: [...RATING.changes, { ...RATING.changes[0], name: 'Second shoes' }] });
  assert.deepEqual(rating.changes.map((c) => c.category), ['shoes', 'hair', 'accessory'], 'one change per category');
  assert.equal(rating.score, 7);
  assert.ok(rating.finalScore <= 9.8 && rating.finalScore > rating.score);
  assert.deepEqual(rating.changes[0].why, ['Modern edge in off-white', 'Elevates the look with structure']);
  assert.equal(rating.changes[0].colorName, 'White');
  const greedy = normalizeRating({ score: 9, summary: '', changes: RATING.changes.map((c) => ({ ...c, points: 1.5 })) });
  assert.ok(greedy.finalScore <= 9.8, 'points are scaled down rather than passing 9.8');
  assert.throws(() => normalizeRating({ score: 7, changes: [] }));
  assert.throws(() => normalizeRating({ score: 7, changes: [{ category: 'face', name: 'Nose job' }] }), 'only clothing, hair and accessories');
  assert.match(ratePrompt({ profile: {}, palette: [] }), /Never comment on the person's body, weight, face, skin, age or attractiveness/);
});

test('a rate visit: the photo is rated, no outfits are designed, and the look is drawn on their own clothes', async () => {
  const openai = openaiFake();
  const { app } = await mirrorApp({ openai, sidecar: fakeSidecar({ bundle: () => bundleFor() }), env: { PRODUCT_PHOTO_DIR: tempDir() } });
  const created = await app.inject({ method: 'POST', url: '/api/v2/sessions', payload: { style: 'Rate my outfit', mode: 'rate', consent: true, imageDataUrl: `data:image/png;base64,${await generatedImage()}` } });
  assert.equal(created.statusCode, 201);
  const id = created.json().sessionId;
  const done = await waitFor(async () => {
    const s = (await app.inject(`/api/v2/sessions/${id}`)).json();
    return s.renders?.find((r) => r.key === '1.1' && r.status === 'done') ? s : null;
  });
  assert.equal(done.mode, 'rate');
  assert.equal(done.rateLook.changes.length, 3);
  assert.equal(done.rounds[0].source, 'rate');
  assert.equal(openai.calls.filter((c) => c.kind === 'design').length, 0, 'no outfit design call');
  const rate = openai.calls.find((c) => c.kind === 'rate');
  assert.equal(rate.images, 1, 'the rating reads the photo');
  const render = openai.calls.find((c) => c.kind === 'render');
  assert.match(render.prompt, /Keep this person's own outfit exactly as it is/);
  assert.match(render.prompt, /Soft Wave Lob/);
  assert.doesNotMatch(render.prompt, /face, hair and skin/, 'hair may change when a hairstyle is suggested');

  // Product photos for the changes: none for the hairstyle.
  const photos = (await app.inject({ method: 'POST', url: `/api/v2/sessions/${id}/product-photos`, payload: { round: 1, option: 1 } })).json().photos;
  assert.deepEqual(photos.map((p) => p.key === null), [false, true, false]);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v2/sessions', payload: { style: 'x', mode: 'nope', consent: true } })).statusCode, 400);
  await app.close();
});

test('the weather comes from the venue location only, and is optional', async () => {
  const none = await mirrorApp({ openai: openaiFake(), sidecar: fakeSidecar({ bundle: () => bundleFor() }) });
  assert.deepEqual((await none.app.inject('/api/v2/context')).json(), { weather: null });
  await none.app.close();

  const { buildApp } = await import('../src/app.js');
  const { loadConfig } = await import('../src/config.js');
  const asked = [];
  const config = loadConfig({ OPENAI_API_KEY: 'k', ARTIFACTS_DIR: tempDir(), RUNTIME_DIR: tempDir(), VENUE_LAT: '12.97', VENUE_LON: '77.59' });
  const app = await buildApp(config, {
    logger: false,
    spawnSidecar: false,
    sidecarFetch: fakeSidecar({ bundle: () => bundleFor() }).fetchImpl,
    weatherFetch: async (url) => {
      asked.push(url);
      return new Response(JSON.stringify({ current: { temperature_2m: 19.4, weather_code: 2 } }), { status: 200 });
    }
  });
  assert.deepEqual((await app.inject('/api/v2/context')).json(), { weather: { temperatureC: 19, kind: 'partly-cloudy' } });
  await app.inject('/api/v2/context');
  assert.equal(asked.length, 1, 'cached between visitors');
  assert.match(asked[0], /latitude=12\.97&longitude=77\.59/);
  await app.close();
});
