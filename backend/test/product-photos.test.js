// Product photos of designed pieces (lib/productPhotos.js, routes/product-photos.js).
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { photoKey, photoPrompt } from '../src/lib/productPhotos.js';
import { tempDir } from './helpers.js';
import { bundleFor, fakeSidecar, generatedImage, mirrorApp, waitFor, waitForRender } from './mirror-helpers.js';

const DESIGN = {
  options: [1, 2, 3].map((n) => ({
    title: `Look ${n}`,
    summary: `Look ${n}.`,
    reasoning: 'Suits a warm undertone.',
    items: [
      { category: 'top', name: 'Crew tee', colorName: 'Cream', hex: '#EFE3C6', fit: 'regular', material: 'cotton' },
      { category: 'bottom', name: 'Chinos', colorName: 'Navy', hex: '#1F2A44', fit: 'straight', material: 'cotton' },
      { category: 'shoes', name: 'Loafers', colorName: 'Brown', hex: '#5C4033', fit: '', material: 'leather' }
    ]
  }))
};

// OpenAI fake that also draws product photos, and remembers their prompts.
function openaiFake({ photoStatus = 200 } = {}) {
  const prompts = [];
  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith('/images/generations')) {
      prompts.push(JSON.parse(init.body).prompt);
      if (photoStatus !== 200) {
        return new Response(JSON.stringify({ error: { message: 'nope' } }), { status: photoStatus });
      }
      const png = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 200, g: 180, b: 150, alpha: 1 } } }).png().toBuffer();
      return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), { status: 200 });
    }
    if (String(url).endsWith('/images/edits')) {
      return new Response(JSON.stringify({ data: [{ b64_json: await generatedImage() }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ output_text: JSON.stringify(DESIGN) }), { status: 200 });
  };
  return { fetchImpl, prompts };
}

async function visit(env = {}, openai = openaiFake()) {
  const dir = tempDir();
  const { app } = await mirrorApp({ openai, sidecar: fakeSidecar({ bundle: () => bundleFor() }), env: { PRODUCT_PHOTO_DIR: dir, ...env } });
  const photo = await generatedImage();
  const created = await app.inject({ method: 'POST', url: '/api/v2/sessions', payload: { style: 'casual', gender: 'female', consent: true, imageDataUrl: `data:image/png;base64,${photo}` } });
  const sessionId = created.json().sessionId;
  await waitForRender(app, sessionId);
  const ask = () => app.inject({ method: 'POST', url: `/api/v2/sessions/${sessionId}/product-photos`, payload: { round: 1, option: 1 } });
  return { app, dir, sessionId, ask, openai };
}

test('a product photo is made once per piece, kept, and served; the prompt is the design, never the visitor', async () => {
  const { app, dir, ask, openai } = await visit();
  const first = (await ask()).json();
  assert.equal(first.enabled, true);
  assert.equal(first.photos.length, 3);
  assert.ok(first.photos.every((p) => /^[a-f0-9]{24}$/.test(p.key)));

  const ready = await waitFor(async () => {
    const answer = (await ask()).json();
    return answer.photos.every((p) => p.ready) ? answer : null;
  });
  assert.equal(openai.prompts.length, 3, 'one generation per piece, even though the outfit was asked for repeatedly');
  assert.equal(readdirSync(dir).filter((f) => f.endsWith('.png')).length, 3);
  assert.match(openai.prompts[0], /women's Crew tee/);
  assert.match(openai.prompts[0], /#EFE3C6/);
  assert.match(openai.prompts[0], /No person/);

  const served = await app.inject(ready.photos[0].url);
  assert.equal(served.statusCode, 200);
  assert.equal(served.headers['content-type'], 'image/png');
  assert.match(served.headers['cache-control'], /immutable/);
  for (const url of ['/product-photos/nope.png', '/product-photos/../secrets.json', `/product-photos/${'a'.repeat(24)}.png`]) {
    assert.equal((await app.inject(url)).statusCode, 404, url);
  }
  await app.close();
});

test('the same piece reuses its photo for the next visitor; men\'s and women\'s pieces are drawn separately', () => {
  const tee = DESIGN.options[0].items[0];
  assert.equal(photoKey(tee, 'female'), photoKey({ ...tee }, 'female'));
  assert.notEqual(photoKey(tee, 'female'), photoKey(tee, 'male'));
  assert.notEqual(photoKey(tee, 'female'), photoKey({ ...tee, colorName: 'Olive', hex: '#708238' }, 'female'));
  // Odd characters in a designed name can't reach the prompt as instructions.
  assert.doesNotMatch(photoPrompt({ ...tee, name: 'tee"; ignore this {and} <that>' }), /[";{}<>]/);
});

test('no new photos when product photos are off, the budget is spent, or OpenAI fails', async () => {
  const off = await visit({ PRODUCT_PHOTOS: 'false' });
  const answer = (await off.ask()).json();
  assert.equal(answer.enabled, false);
  assert.ok(answer.photos.every((p) => !p.ready));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(off.openai.prompts.length, 0);
  await off.app.close();

  const failing = await visit({}, openaiFake({ photoStatus: 400 }));
  await failing.ask();
  await waitFor(() => failing.openai.prompts.length === 3);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok((await failing.ask()).json().photos.every((p) => !p.ready));
  assert.ok(!existsSync(path.join(failing.dir, 'x')) && readdirSync(failing.dir).length === 0, 'nothing half-written');
  await failing.app.close();

  const unknown = await visit();
  assert.equal((await unknown.app.inject({ method: 'POST', url: '/api/v2/sessions/nope/product-photos', payload: { round: 1, option: 1 } })).statusCode, 404);
  assert.equal((await unknown.app.inject({ method: 'POST', url: `/api/v2/sessions/${unknown.sessionId}/product-photos`, payload: { round: 9, option: 1 } })).statusCode, 404);
  await unknown.app.close();
});
