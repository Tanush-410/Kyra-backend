import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { createOpenAI } from '../src/lib/openai.js';
import { tempDir } from './helpers.js';
import { bundleFor, fakeSidecar, generatedImage, listenWithEvents, mirrorApp, waitFor, waitForRender } from './mirror-helpers.js';

const DESIGN = {
  options: ['Teal', 'Navy', 'Olive'].map((name, i) => ({
    title: `${name} look`,
    summary: `${name} jacket with cream trousers ${i}.`,
    reasoning: 'Suits the palette.',
    items: [
      { category: 'top', name: `${name} jacket`, colorName: name, hex: ['#1E7A73', '#1F2A44', '#6B7036'][i], fit: 'slim', material: 'wool' },
      { category: 'bottom', name: 'Trousers', colorName: 'Cream', hex: '#EFE3C6', fit: 'straight', material: 'cotton' }
    ]
  }))
};

// OpenAI fake where image latency depends on the requested quality, so drafts land first.
function timedOpenAI({ draftMs = 20, finalMs = 250 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/images/edits')) {
      const quality = init.body.get('quality');
      calls.push({ kind: 'image', quality, url: String(url) });
      await new Promise((resolve) => setTimeout(resolve, quality === 'low' ? draftMs : finalMs));
      return new Response(JSON.stringify({ data: [{ b64_json: await generatedImage() }] }), { status: 200 });
    }
    calls.push({ kind: 'text', url: String(url), text: JSON.parse(init.body).input[0].content[0].text });
    return new Response(JSON.stringify({ output_text: JSON.stringify(DESIGN) }), { status: 200 });
  };
  return { fetchImpl, calls, images: () => calls.filter((c) => c.kind === 'image') };
}

async function photo() {
  const buffer = await sharp({ create: { width: 600, height: 900, channels: 3, background: { r: 120, g: 110, b: 100 } } })
    .composite([{ input: await sharp({ create: { width: 200, height: 600, channels: 3, background: { r: 30, g: 40, b: 60 } } }).png().toBuffer(), left: 200, top: 200 }])
    .jpeg()
    .toBuffer();
  return `data:image/jpeg;base64,${buffer.toString('base64')}`;
}

const start = async (app, extra = {}) =>
  app.inject({ method: 'POST', url: '/api/v2/sessions', payload: { style: 'smart casual', consent: true, imageDataUrl: await photo(), ...extra } });

test('consent is required before a session can capture, unless switched off', async () => {
  const { app } = await mirrorApp({ openai: timedOpenAI(), sidecar: fakeSidecar({ bundle: () => bundleFor() }) });
  const refused = await start(app, { consent: undefined });
  assert.equal(refused.statusCode, 400);
  assert.equal(refused.json().code, 'consent_required');
  await app.close();

  const relaxed = await mirrorApp({ openai: timedOpenAI(), sidecar: fakeSidecar({ bundle: () => bundleFor() }), env: { REQUIRE_CONSENT: 'false' } });
  assert.equal((await start(relaxed.app, { consent: undefined })).statusCode, 201);
  await relaxed.app.close();
});

test('a low-quality draft is shown first, then replaced by the final render', async (t) => {
  const openai = timedOpenAI();
  // LOOK_TOKEN_BUDGET=0 lifts the token rule, which would otherwise skip the draft (see the next test).
  const { app } = await mirrorApp({ openai, sidecar: fakeSidecar({ bundle: () => bundleFor() }), env: { RENDER_DRAFT: 'true', LOOK_TOKEN_BUDGET: '0', FINAL_QUALITY: 'medium' } });
  const { seen } = await listenWithEvents(app, t);
  const id = (await start(app)).json().sessionId;
  await waitFor(() => seen.find((e) => e.type === 'session.render.done' && e.sessionId === id));
  const order = seen.filter((e) => e.sessionId === id).map((e) => e.type);
  assert.ok(order.indexOf('session.render.draft') >= 0 && order.indexOf('session.render.draft') < order.indexOf('session.render.done'));
  assert.deepEqual(openai.images().map((c) => c.quality).sort(), ['low', 'medium']);
  const metrics = (await app.inject('/api/v2/metrics')).json();
  assert.equal(metrics.budget.calls.draft, 1);
  assert.equal(metrics.budget.calls.image, 1);
  assert.ok(metrics.steps.first_image.p50Ms < metrics.steps.render_total.p50Ms);
});

test('prefetch renders the other options in the background, and asking for one is then instant', async () => {
  const openai = timedOpenAI({ finalMs: 30 });
  const { app } = await mirrorApp({ openai, sidecar: fakeSidecar({ bundle: () => bundleFor() }), env: { PREFETCH_OPTIONS: 'auto' } });
  const id = (await start(app)).json().sessionId;
  const done = await waitFor(async () => {
    const session = (await app.inject(`/api/v2/sessions/${id}`)).json();
    return session.renders.filter((r) => r.status === 'done').length === 3 ? session : null;
  });
  assert.deepEqual(done.renders.map((r) => [r.key, r.prefetch]), [['1.1', false], ['1.2', true], ['1.3', true]]);
  assert.equal(done.activeKey, '1.1', 'background renders do not change what the visitor is looking at');

  const before = openai.images().length;
  const asked = await app.inject({ method: 'POST', url: `/api/v2/sessions/${id}/render`, payload: { round: 1, option: 2 } });
  assert.equal(asked.json().status, 'done');
  assert.equal(openai.images().length, before, 'no new image call');
  assert.equal((await app.inject(`/api/v2/sessions/${id}`)).json().activeKey, '1.2');
  await app.close();
});

test('prefetch stays off once spend passes the prefetch share of the budget', async () => {
  const openai = timedOpenAI({ finalMs: 10 });
  const { app } = await mirrorApp({ openai, sidecar: fakeSidecar({ bundle: () => bundleFor() }), env: { PREFETCH_OPTIONS: 'auto', DAILY_BUDGET_USD: '0.15' } });
  const id = (await start(app)).json().sessionId;
  await waitForRender(app, id);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(openai.images().length, 1, '$0.085 of $0.15 is over 50%, so nothing is prefetched');
  await app.close();
});

test('the visitor can correct the profile: new palette, new design, and the correction is logged for tuning', async () => {
  const openai = timedOpenAI({ finalMs: 10 });
  const sidecar = fakeSidecar({ bundle: () => bundleFor({ skin: { skinUndertone: 'cool', skinDepth: 'light', confidence: 'medium', hueAngle: 49 } }) });
  const { app } = await mirrorApp({ openai, sidecar });
  const id = (await start(app)).json().sessionId;
  const first = (await waitForRender(app, id)).session;
  assert.equal(first.palette[0].name, 'Soft pink');

  const corrected = await app.inject({ method: 'POST', url: `/api/v2/sessions/${id}/profile`, payload: { skinUndertone: 'warm', heightCm: 158 } });
  assert.equal(corrected.statusCode, 200, corrected.body);
  const body = corrected.json();
  assert.equal(body.profile.skinUndertone, 'warm');
  assert.equal(body.profile.heightImpression, 'petite');
  assert.equal(body.profile.corrected, true);
  assert.equal(body.palette[0].name, 'Peach');
  assert.equal(body.rounds.length, 2);
  assert.match(openai.calls.filter((c) => c.kind === 'text')[1].text, /Peach #F4B796/);

  const { insights } = (await app.inject('/api/v2/metrics')).json();
  assert.equal(insights.undertoneCorrections, 1);
  assert.deepEqual(insights.hueByCorrectedUndertone.warm, { count: 1, min: 49, median: 49, max: 49 });
  assert.equal((await app.inject({ method: 'POST', url: `/api/v2/sessions/${id}/profile`, payload: {} })).statusCode, 400);
  await app.close();
});

test('ratings are stored anonymously and summarised per undertone', async () => {
  const runtime = tempDir();
  const { app } = await mirrorApp({ openai: timedOpenAI({ finalMs: 10 }), sidecar: fakeSidecar({ bundle: () => bundleFor() }), env: { RUNTIME_DIR: runtime } });
  const id = (await start(app)).json().sessionId;
  await waitForRender(app, id);
  assert.equal((await app.inject({ method: 'POST', url: `/api/v2/sessions/${id}/rate`, payload: { round: 1, option: 1, rating: 'up' } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: `/api/v2/sessions/${id}/rate`, payload: { round: 1, option: 2, rating: 'down' } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: `/api/v2/sessions/${id}/rate`, payload: { round: 1, option: 1, rating: 'meh' } })).statusCode, 400);
  const { insights } = (await app.inject('/api/v2/metrics')).json();
  assert.equal(insights.ratings, 2);
  assert.equal(insights.approvalPercent, 50);
  assert.equal(insights.byUndertone.warm.ratings, 2);
  assert.ok(existsSync(path.join(runtime, 'ratings.jsonl')));
  await app.close();
});

test('gestures: thumbs down moves to the next look, thumbs up likes it, victory keeps it with a QR code', async (t) => {
  const sidecar = fakeSidecar({ bundle: () => bundleFor() });
  // Watched as the operator, who sees every session's images and links on one stream.
  const { app } = await mirrorApp({ openai: timedOpenAI({ finalMs: 10 }), sidecar, env: { OPERATOR_TOKEN: 'ops' } });
  const { seen } = await listenWithEvents(app, t, '?token=ops');
  await waitFor(() => sidecar.connected());
  const id = (await start(app)).json().sessionId;
  await waitForRender(app, id, '1.1');

  sidecar.emit({ type: 'gesture', gesture: 'thumb_down' });
  await waitForRender(app, id, '1.2');
  assert.equal((await app.inject(`/api/v2/sessions/${id}`)).json().activeKey, '1.2');

  sidecar.emit({ type: 'gesture', gesture: 'thumb_up' });
  await waitFor(() => seen.find((e) => e.type === 'session.rated' && e.rating === 'up'));

  sidecar.emit({ type: 'gesture', gesture: 'victory' });
  const kept = await waitFor(() => seen.find((e) => e.type === 'session.kept'));
  assert.equal(kept.option, 2);
  assert.match(kept.qrDataUrl, /^data:image\/png;base64,/);

  sidecar.emit({ type: 'gesture', gesture: 'closed_fist' });
  await waitFor(() => seen.find((e) => e.type === 'gesture' && e.gesture === 'closed_fist' && e.action === null));
  const ratings = seen.filter((e) => e.type === 'session.rated').map((e) => `${e.option}:${e.rating}`);
  assert.deepEqual(ratings, ['1:down', '2:up']);
});

test('a budget warning event fires once when spend crosses the warning level', async (t) => {
  const { app } = await mirrorApp({ openai: timedOpenAI({ finalMs: 10 }), sidecar: fakeSidecar({ bundle: () => bundleFor() }), env: { DAILY_BUDGET_USD: '0.1' } });
  const { seen } = await listenWithEvents(app, t);
  const id = (await start(app)).json().sessionId;
  await waitForRender(app, id);
  await waitFor(() => seen.some((e) => e.type === 'budget.warning'));
  const warnings = seen.filter((e) => e.type === 'budget.warning');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].spentUsd, 0.085, 'design $0.02 + image $0.065 (estimates: the mock returns no usage), past 80% of $0.10');
});

test('OPENAI_BASE_URL points every call at another server (mocks, proxies, load tests)', async () => {
  const urls = [];
  const openai = createOpenAI({
    apiKey: 'k',
    model: 'm',
    imageModel: 'i',
    baseUrl: 'http://127.0.0.1:9999/v1',
    maxRetries: 0,
    fetchImpl: async (url) => {
      urls.push(url);
      return new Response(JSON.stringify({ output_text: 'ok' }), { status: 200 });
    }
  });
  await openai.respond({ text: 'hi' });
  assert.deepEqual(urls, ['http://127.0.0.1:9999/v1/responses']);
});

test('HTTPS: with TLS_CERT_FILE and TLS_KEY_FILE the server speaks TLS', { skip: !existsSync('/usr/bin/openssl') }, async () => {
  const dir = tempDir();
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  const { app } = await mirrorApp({ openai: timedOpenAI(), sidecar: fakeSidecar({ bundle: () => bundleFor() }), env: { TLS_CERT_FILE: cert, TLS_KEY_FILE: key } });
  assert.equal(app.server.constructor.name, 'Server');
  assert.ok(app.initialConfig.https, 'fastify was created with https options');
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address();
  const response = await new Promise((resolve, reject) => {
    import('node:https').then(({ get }) =>
      get({ host: '127.0.0.1', port, path: '/health', rejectUnauthorized: false }, resolve).on('error', reject)
    );
  });
  assert.equal(response.statusCode, 200);
  assert.ok(response.socket.encrypted);
  await app.close();
});

test('real token usage is recorded per call, priced per token, and charged to the budget', async () => {
  const { createUsageLog, priceUsage } = await import('../src/lib/usage.js');
  const image = { input_tokens: 403, input_tokens_details: { image_tokens: 323, text_tokens: 80 }, output_tokens: 2166 };
  // Real usage from the original pipeline's try-on call:
  // 242 text in * $5/M + 517 image in * $8/M + 1584 image out * $32/M + 330 text out * $10/M = $0.059334
  const original = { input_tokens: 759, input_tokens_details: { image_tokens: 517, text_tokens: 242 }, output_tokens: 1914, output_tokens_details: { image_tokens: 1584, text_tokens: 330 } };
  const { normaliseUsage } = await import('../src/lib/usage.js');
  assert.equal(Math.round(priceUsage('gpt-image-1.5', 'images', normaliseUsage(original, 'images')) * 1e6), 59334);
  // Without an output breakdown, all output is billed as image output: 80*5 + 323*8 + 2166*32 per M = $0.072296
  assert.equal(Math.round(priceUsage('gpt-image-1.5', 'images', normaliseUsage(image, 'images')) * 1e6), 72296);
  const log = createUsageLog();
  log.record({ endpoint: 'images', model: 'gpt-image-1.5', kind: 'image', usage: image });
  log.record({ endpoint: 'responses', model: 'gpt-5.2', kind: 'design', usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 200 }, output_tokens: 500, output_tokens_details: { reasoning_tokens: 100 } } });
  const summary = log.summary();
  // 800 * 1.75/M + 200 * 0.175/M + 500 * 14/M = 0.0084350
  assert.equal(summary.byKind.design.usd, 0.008435);
  assert.equal(summary.byKind.image.imageInputTokens, 323);
  assert.equal(summary.byKind.design.reasoningTokens, 100);

  const usageFetch = async (url, init) => {
    if (String(url).endsWith('/images/edits')) {
      return new Response(JSON.stringify({ data: [{ b64_json: await generatedImage() }], usage: image }), { status: 200 });
    }
    return new Response(JSON.stringify({ output_text: JSON.stringify(DESIGN), usage: { input_tokens: 1000, output_tokens: 500 } }), { status: 200 });
  };
  const { app } = await mirrorApp({ openai: { fetchImpl: usageFetch }, sidecar: fakeSidecar({ bundle: () => bundleFor() }), env: { FINAL_QUALITY: 'low' } });
  const id = (await start(app)).json().sessionId;
  await waitForRender(app, id);
  const metrics = (await app.inject('/api/v2/metrics')).json();
  assert.equal(metrics.usage.byKind.design.calls, 1);
  assert.equal(metrics.usage.byKind['image:low'].outputTokens, 2166);
  // budget charged real cost: 1000*1.75/M + 500*14/M = 0.00875 plus 0.072296 = 0.081046
  assert.equal(metrics.budget.spentUsd, 0.081046);
  await app.close();
});


test('quality A/B test: visitors alternate between low and medium finals; likes and real cost are split by quality', async () => {
  const image = (q) => ({ input_tokens: 571, input_tokens_details: { image_tokens: 323, text_tokens: 248 }, output_tokens: q === 'low' ? 572 : 2151, output_tokens_details: { image_tokens: q === 'low' ? 408 : 1784, text_tokens: q === 'low' ? 164 : 367 } });
  const qualities = [];
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/images/edits')) {
      const quality = init.body.get('quality');
      qualities.push(quality);
      return new Response(JSON.stringify({ data: [{ b64_json: await generatedImage() }], usage: image(quality) }), { status: 200 });
    }
    return new Response(JSON.stringify({ output_text: JSON.stringify(DESIGN) }), { status: 200 });
  };
  const { app } = await mirrorApp({ openai: { fetchImpl }, sidecar: fakeSidecar({ bundle: () => bundleFor() }), env: { FINAL_QUALITY_EXPERIMENT: 'low,medium' } });
  const ids = [];
  for (let i = 0; i < 4; i += 1) {
    const id = (await start(app)).json().sessionId;
    ids.push(id);
    await waitForRender(app, id);
  }
  assert.deepEqual(qualities, ['low', 'medium', 'low', 'medium']);
  assert.equal((await app.inject(`/api/v2/sessions/${ids[0]}`)).json().experiment.finalQuality, 'low');
  for (const [i, id] of ids.entries()) {
    await app.inject({ method: 'POST', url: `/api/v2/sessions/${id}/rate`, payload: { round: 1, option: 1, rating: i === 3 ? 'down' : 'up' } });
  }
  const { insights, usage } = (await app.inject('/api/v2/metrics')).json();
  assert.deepEqual(insights.byFinalQuality, { low: { ratings: 2, approvalPercent: 100 }, medium: { ratings: 2, approvalPercent: 50 } });
  assert.equal(usage.byKind['image:low'].calls, 2);
  assert.ok(usage.byKind['image:low'].usd < usage.byKind['image:medium'].usd / 2.5, 'low quality costs well under half');
  await app.close();
});

test('early design: outfits designed from the early profile are reused at capture, so option 1 renders at once', async (t) => {
  const sidecar = fakeSidecar({ bundle: () => bundleFor() });
  const openai = timedOpenAI({ finalMs: 10 });
  const { app } = await mirrorApp({ openai, sidecar });
  const { seen } = await listenWithEvents(app, t);
  await waitFor(() => sidecar.connected());
  const id = (await (await fetch(`http://127.0.0.1:${app.server.address().port}/api/v2/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ style: 'office', consent: true }) })).json()).sessionId;

  const early = (await bundleFor()).profile;
  sidecar.emit({ type: 'profile', sessionId: id, profile: early });
  await waitFor(() => openai.calls.filter((c) => c.kind === 'text').length === 1);
  assert.equal(seen.filter((e) => e.sessionId === id && e.type === 'session.option').length, 0, 'nothing published before the photo');
  sidecar.emit({ type: 'profile', sessionId: id, profile: early });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(openai.calls.filter((c) => c.kind === 'text').length, 1, 'same profile is not designed twice');

  sidecar.emit({ type: 'capture', sessionId: id, captureId: 'cap123' });
  await waitFor(() => seen.find((e) => e.sessionId === id && e.type === 'session.render.done'));
  assert.equal(openai.calls.filter((c) => c.kind === 'text').length, 1, 'no second design call at capture');
  const metrics = (await app.inject('/api/v2/metrics')).json();
  assert.equal(metrics.counters.early_design_hits, 1);
  assert.ok(metrics.steps.capture_to_first_option.p50Ms < 100, `options were ready at capture (${metrics.steps.capture_to_first_option.p50Ms} ms)`);
});

test('early design is recoloured in code (no second design call) when the capture shows a different palette', async (t) => {
  const sidecar = fakeSidecar({ bundle: () => bundleFor({ skin: { skinUndertone: 'cool', skinDepth: 'light', confidence: 'medium' } }) });
  const openai = timedOpenAI({ finalMs: 10 });
  const { app } = await mirrorApp({ openai, sidecar });
  const { seen } = await listenWithEvents(app, t);
  await waitFor(() => sidecar.connected());
  const id = (await (await fetch(`http://127.0.0.1:${app.server.address().port}/api/v2/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ style: 'office', consent: true }) })).json()).sessionId;
  sidecar.emit({ type: 'profile', sessionId: id, profile: (await bundleFor()).profile }); // warm, medium
  await waitFor(() => openai.calls.filter((c) => c.kind === 'text').length === 1);
  sidecar.emit({ type: 'capture', sessionId: id, captureId: 'cap123' });
  await waitFor(() => seen.find((e) => e.sessionId === id && e.type === 'session.render.done'));
  assert.equal(openai.calls.filter((c) => c.kind === 'text').length, 1, 'no second design call: it would break the token rule');
  const session = (await app.inject(`/api/v2/sessions/${id}`)).json();
  const coolPalette = session.palette.concat(session.neutrals).map((c) => c.hex);
  assert.ok(session.rounds[0].options.flatMap((o) => o.items).every((item) => coolPalette.includes(item.hex)), 'early outfits recoloured into the cool palette');
  assert.equal((await app.inject('/api/v2/metrics')).json().counters.early_design_recoloured, 1);
});

test('dwell prefetch: the next look renders only after the visitor has looked for the dwell time and is still there', async (t) => {
  const sidecar = fakeSidecar({ bundle: () => bundleFor() });
  const openai = timedOpenAI({ finalMs: 10 });
  const { app } = await mirrorApp({ openai, sidecar, env: { PREFETCH_OPTIONS: 'dwell', PREFETCH_DWELL_MS: '150' } });
  await listenWithEvents(app, t);
  await waitFor(() => sidecar.connected());
  const id = (await start(app)).json().sessionId;
  await waitForRender(app, id);
  assert.equal(openai.images().length, 1);
  await waitFor(() => openai.images().length === 2, { timeoutMs: 2000 });
  const session = (await app.inject(`/api/v2/sessions/${id}`)).json();
  assert.deepEqual(session.renders.map((r) => [r.key, r.prefetch]), [['1.1', false], [`1.${session.rounds[0].order[1]}`, true]]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(openai.images().length, 2, 'only one look ahead, not the whole round');

});

test('dwell prefetch is skipped when the camera sees the visitor has walked away', async (t) => {
  const sidecar = fakeSidecar({ bundle: () => bundleFor() });
  const openai = timedOpenAI({ finalMs: 10 });
  const { app } = await mirrorApp({ openai, sidecar, env: { PREFETCH_OPTIONS: 'dwell', PREFETCH_DWELL_MS: '200', AUTO_END_ON_LEAVE: 'false' } });
  const { base, seen } = await listenWithEvents(app, t);
  await waitFor(() => sidecar.connected());
  const id = (await (await fetch(`${base}/api/v2/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ style: 'office', consent: true }) })).json()).sessionId;
  sidecar.emit({ type: 'capture', sessionId: id, captureId: 'cap123' });
  await waitFor(() => seen.find((e) => e.sessionId === id && e.type === 'session.render.done'));
  sidecar.emit({ type: 'presence', present: false });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(openai.images().length, 1, 'nobody is looking, so nothing is rendered ahead');
});

test('learning from likes: liked colours lead the palette, steer the designer, and order the next looks', async () => {
  const runtime = tempDir();
  const { createInsights } = await import('../src/lib/insights.js');
  const seed = createInsights({ dir: runtime });
  for (let i = 0; i < 12; i += 1) {
    seed.recordRating({ rating: 'up', undertone: 'warm', colors: ['Olive', 'Cream'] });
    seed.recordRating({ rating: 'down', undertone: 'warm', colors: ['Teal', 'Cream'] });
  }
  const openai = timedOpenAI({ finalMs: 10 });
  const { app } = await mirrorApp({ openai, sidecar: fakeSidecar({ bundle: () => bundleFor() }), env: { RUNTIME_DIR: runtime, LEARN_MIN_RATINGS: '20' } });
  const id = (await start(app)).json().sessionId;
  const { session } = await waitForRender(app, id);
  assert.equal(session.palette[0].name, 'Olive', 'most-liked colour first');
  const prompt = openai.calls.find((c) => c.kind === 'text').text;
  assert.match(prompt, /Liked by similar visitors: Olive/);
  assert.match(prompt, /Less liked: Teal/);
  // Olive+Cream scores (13/14 + 13/26) / 2 = 0.71; Navy (unrated, 0.5) + Cream = 0.5: the Olive look is next.
  assert.deepEqual(session.rounds[0].order, [1, 3, 2]);
  const next = await app.inject({ method: 'POST', url: `/api/v2/sessions/${id}/next` });
  assert.equal(next.json().option, session.rounds[0].order[1]);
  await app.close();
});

test('"looks right" confirmations feed the threshold tuner alongside corrections', async () => {
  const { tuneThresholds } = await import('../src/lib/threshold-tuning.js');
  const samples = [
    ...[44, 46, 48, 49, 51].map((hue) => ({ hue, undertone: 'cool' })),
    ...[54, 55, 56].map((hue) => ({ hue, undertone: 'neutral' })),
    ...[59, 61, 63, 65].map((hue) => ({ hue, undertone: 'warm' }))
  ];
  const result = tuneThresholds(samples, { coolMax: 50, warmMin: 58 });
  assert.equal(result.current.accuracy, 0.917, 'hue 51 said cool is misread as neutral today');
  assert.equal(result.suggested.accuracy, 1);
  assert.ok(result.suggested.coolMax >= 51 && result.suggested.coolMax < 54);
  assert.equal(result.enoughData, true);

  const { app } = await mirrorApp({ openai: timedOpenAI({ finalMs: 10 }), sidecar: fakeSidecar({ bundle: () => bundleFor() }) });
  const id = (await start(app)).json().sessionId;
  await waitForRender(app, id);
  assert.equal((await app.inject({ method: 'POST', url: `/api/v2/sessions/${id}/profile/confirm` })).statusCode, 200);
  const { insights } = (await app.inject('/api/v2/metrics')).json();
  assert.equal(insights.confirmations, 1);
  assert.equal(insights.corrections, 0);
  assert.equal(insights.thresholds.samples, 1);
  await app.close();
});

test('confirmations log L*a*b* so the undertone detector can be fitted from them', async () => {
  const sidecar = fakeSidecar({ bundle: () => bundleFor() });
  const { app } = await mirrorApp({ openai: timedOpenAI({ finalMs: 10 }), sidecar });
  const id = (await start(app)).json().sessionId;
  await waitForRender(app, id);
  await app.inject({ method: 'POST', url: `/api/v2/sessions/${id}/profile/confirm` });
  const fit = await app.inject({ method: 'POST', url: '/api/v2/calibrate/undertone', payload: {} });
  assert.equal(fit.statusCode, 200);
  assert.equal(fit.json().saved, false, 'a fit is only applied when asked');
  const call = sidecar.calls.find((c) => c.pathname === '/calibrate/undertone');
  assert.deepEqual(call.body.samples, [{ L: 60, a: 14, b: 22, label: 'warm' }]);
  await app.close();
});


// Realistic usage, as measured on real calls: design ~1,150 tokens before compression, low image ~1,300.
function usageOpenAI({ designUsage = { input_tokens: 330, output_tokens: 420 }, imageUsage = { input_tokens: 520, input_tokens_details: { image_tokens: 323, text_tokens: 197 }, output_tokens: 700, output_tokens_details: { image_tokens: 508, text_tokens: 192 } }, faceCheckFails = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/images/edits')) {
      calls.push({ kind: 'image', quality: init.body.get('quality'), images: init.body.getAll('image[]').length, prompt: init.body.get('prompt') });
      return new Response(JSON.stringify({ data: [{ b64_json: await generatedImage() }], usage: imageUsage }), { status: 200 });
    }
    calls.push({ kind: 'text' });
    return new Response(JSON.stringify({ output_text: JSON.stringify(DESIGN), usage: designUsage }), { status: 200 });
  };
  return { fetchImpl, calls, images: () => calls.filter((c) => c.kind === 'image') };
}

test('token rule: at FINAL_QUALITY=low a look uses fewer tokens than the original pipeline (2,673), and says so', async () => {
  const openai = usageOpenAI();
  const { app } = await mirrorApp({ openai, sidecar: fakeSidecar({ bundle: () => bundleFor() }), env: { FINAL_QUALITY: 'low', LOOK_TOKEN_BUDGET: '2600' } });
  const id = (await start(app)).json().sessionId;
  const { render } = await waitForRender(app, id);
  assert.equal(openai.images()[0].quality, 'low');
  assert.deepEqual(render.tokens, { design: 750, image: 1220, total: 1970, original: 2673, underOriginal: true });
  const metrics = (await app.inject('/api/v2/metrics')).json();
  assert.equal(metrics.steps.tokens_per_look.p50Ms, 1970);
  assert.equal(metrics.counters.looks_over_original_tokens, undefined);
  await app.close();
});

test('token rule: drafts and face-check retries are skipped when they would push a look over budget', async () => {
  const sidecar = fakeSidecar({ bundle: () => bundleFor(), compose: () => ({ headPasted: false, handsPasted: [], similarity: 0.2, samePerson: false, threshold: 0.363, alignment: {} }) });
  const openai = usageOpenAI();
  const { app } = await mirrorApp({ openai, sidecar, env: { RENDER_DRAFT: 'true', FINAL_QUALITY: 'low', LOOK_TOKEN_BUDGET: '2600', RENDER_RETRIES: '1' } });
  const id = (await start(app)).json().sessionId;
  const { render } = await waitForRender(app, id);
  assert.equal(openai.images().length, 1, 'no draft and no retry: either would cross 2,600 tokens');
  assert.equal(render.faceCheck.passed, false, 'the failed check is reported instead of paying for a retry');
  const { counters } = (await app.inject('/api/v2/metrics')).json();
  assert.equal(counters.drafts_skipped_for_token_budget, 1);
  assert.equal(counters.retries_skipped_for_token_budget, 1);
  await app.close();
});

test('soft webcam face: the close-up always goes to compose (the face is placed locally), and to the model only if RENDER_FACE_REFERENCE=true', async () => {
  const bundle = async () => {
    const b = await bundleFor();
    b.render.faceSourcePx = 45;
    b.render.upscale = 2.6;
    b.render.faceRefDataUrl = b.render.keepMaskDataUrl; // any small image stands in for the close-up
    return b;
  };
  // Default: no face image to the model (saves ~190 tokens), but compose still gets the close-up.
  const lean = usageOpenAI();
  const leanSidecar = fakeSidecar({ bundle });
  const leanApp = (await mirrorApp({ openai: lean, sidecar: leanSidecar })).app;
  await waitForRender(leanApp, (await start(leanApp)).json().sessionId);
  assert.equal(lean.images()[0].images, 1);
  assert.doesNotMatch(lean.images()[0].prompt, /Image 2/);
  assert.ok(leanSidecar.callsTo('/compose')[0].body.referenceFaceDataUrl);
  await leanApp.close();

  const sidecar = fakeSidecar({ bundle });
  const openai = usageOpenAI();
  const { app } = await mirrorApp({ openai, sidecar, env: { RENDER_FACE_REFERENCE: 'true' } });
  const id = (await start(app)).json().sessionId;
  const { render } = await waitForRender(app, id);
  assert.equal(openai.images()[0].images, 2);
  assert.match(openai.images()[0].prompt, /Image 2 is a close-up of the same face/);
  const compose = sidecar.callsTo('/compose')[0].body;
  assert.equal(compose.faceSourcePx, 45);
  assert.equal(compose.upscale, 2.6);
  assert.ok(compose.referenceFaceDataUrl);
  assert.equal(render.faceCheck.faceReference, true);
  await app.close();

  // A sharp capture sends just the one image.
  const plain = usageOpenAI();
  const second = await mirrorApp({ openai: plain, sidecar: fakeSidecar({ bundle: () => bundleFor() }) });
  await waitForRender(second.app, (await start(second.app)).json().sessionId);
  assert.equal(plain.images()[0].images, 1);
  await second.app.close();
});

test('early design is keyed on skin: height/build jitter does not trigger new design calls, and is capped', async (t) => {
  const sidecar = fakeSidecar({ bundle: () => bundleFor({ heightCm: 181 }) });
  const openai = usageOpenAI();
  const { app } = await mirrorApp({ openai, sidecar });
  const { base, seen } = await listenWithEvents(app, t);
  await waitFor(() => sidecar.connected());
  const id = (await (await fetch(`${base}/api/v2/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ style: 'office', consent: true }) })).json()).sessionId;
  const profile = (await bundleFor()).profile;
  for (const [cm, build] of [[170, 'medium'], [178, 'slim'], [182, 'broad'], [175, 'medium']]) {
    sidecar.emit({ type: 'profile', sessionId: id, profile: { ...profile, height: { cm, method: 'calibrated' }, frame: { build } } });
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(openai.calls.filter((c) => c.kind === 'text').length, 1, 'four jittery readings, one design');
  for (const tone of ['cool', 'neutral', 'warm']) {
    sidecar.emit({ type: 'profile', sessionId: id, profile: { ...profile, skin: { ...profile.skin, skinUndertone: tone } } });
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(openai.calls.filter((c) => c.kind === 'text').length, 1, 'capped at EARLY_DESIGN_MAX=1');

  sidecar.emit({ type: 'capture', sessionId: id, captureId: 'cap123' });
  const done = await waitFor(() => seen.find((e) => e.sessionId === id && e.type === 'session.render.done'));
  assert.equal(openai.calls.filter((c) => c.kind === 'text').length, 1);
  assert.deepEqual(done.tokens, { design: 750, image: 1220, total: 1970, original: 2673, underOriginal: true });
});

test('early design is skipped when even one design plus its image would break the token budget', async (t) => {
  const sidecar = fakeSidecar({ bundle: () => bundleFor() });
  const openai = usageOpenAI();
  const { app } = await mirrorApp({ openai, sidecar, env: { LOOK_TOKEN_BUDGET: '1500' } });
  const { base } = await listenWithEvents(app, t);
  await waitFor(() => sidecar.connected());
  const id = (await (await fetch(`${base}/api/v2/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ style: 'office', consent: true }) })).json()).sessionId;
  sidecar.emit({ type: 'profile', sessionId: id, profile: (await bundleFor()).profile });
  await new Promise((resolve) => setTimeout(resolve, 100));
  // Seeded estimates: 900 design + 1,100 image = 2,000 > 1,500.
  assert.equal(openai.calls.filter((c) => c.kind === 'text').length, 0);
  assert.equal((await app.inject('/api/v2/metrics')).json().counters.early_designs_skipped_for_token_budget, 1);
});

test('an unsure skin reading falls back to a labelled neutral, never "unknown"', async () => {
  const openai = timedOpenAI({ finalMs: 10 });
  const sidecar = fakeSidecar({ bundle: () => bundleFor({ skin: { skinUndertone: 'cool', skinDepth: 'deep', confidence: 'low' } }) });
  const { app } = await mirrorApp({ openai, sidecar });
  const id = (await start(app)).json().sessionId;
  await waitForRender(app, id);
  const { profile } = (await app.inject(`/api/v2/sessions/${id}`)).json();
  assert.equal(profile.skinUndertone, 'neutral');
  assert.equal(profile.skinUndertoneSource, 'fallback');
  assert.equal(profile.skinDepth, null, 'an unsure depth is not used for the palette');
  assert.equal(profile.skinMeasurement.skinUndertone, 'cool', 'the raw reading is still shown');
  const design = openai.calls.find((c) => c.kind === 'text');
  assert.match(design.text, /neutral undertone/);
  assert.doesNotMatch(design.text, /unknown/);
  await app.close();
});

test('olive skin from the undertone detector gets the olive palette and is named in the design prompt', async () => {
  const openai = timedOpenAI({ finalMs: 10 });
  const skin = { skinUndertone: 'neutral', skinDepth: 'medium', confidence: 'medium', warmCool: { score: 0.1, stable: true, olive: true } };
  const { app } = await mirrorApp({ openai, sidecar: fakeSidecar({ bundle: () => bundleFor({ skin }) }) });
  const id = (await start(app)).json().sessionId;
  await waitForRender(app, id);
  const session = (await app.inject(`/api/v2/sessions/${id}`)).json();
  assert.equal(session.profile.olive, true);
  assert.ok(session.palette.some((c) => c.name === 'Deep olive'), 'olive palette');
  assert.match(openai.calls.find((c) => c.kind === 'text').text, /olive neutral undertone/);

  // Choosing an undertone by hand replaces the measured olive cast.
  await app.inject({ method: 'POST', url: `/api/v2/sessions/${id}/profile`, payload: { skinUndertone: 'warm' } });
  const corrected = (await app.inject(`/api/v2/sessions/${id}`)).json();
  assert.equal(corrected.profile.olive, false);
  assert.ok(!corrected.palette.some((c) => c.name === 'Deep olive'));
  await app.close();
});

test('the undertone is shown from the face alone, before the head-to-toe capture', async (t) => {
  const sidecar = fakeSidecar({ bundle: () => bundleFor() });
  const openai = timedOpenAI({ finalMs: 10 });
  const { app } = await mirrorApp({ env: { EARLY_DESIGN: 'false' }, openai, sidecar });
  const { seen } = await listenWithEvents(app, t);
  await waitFor(() => sidecar.connected());
  const id = (await (await fetch(`http://127.0.0.1:${app.server.address().port}/api/v2/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ style: 'office', consent: true }) })).json()).sessionId;

  // Too close for a capture: no height or build yet, only the face.
  const unsure = { skin: { method: 'undertone-detector', skinUndertone: 'cool', skinDepth: 'tan', confidence: 'low', hueAngle: 49 }, height: { cm: null }, frame: null };
  sidecar.emit({ type: 'profile', sessionId: id, profile: unsure });
  const first = await waitFor(() => seen.find((e) => e.sessionId === id && e.type === 'session.skin'));
  assert.equal(first.skinUndertoneSource, 'fallback', 'an unsure reading is shown as still reading');

  const sure = { ...unsure, skin: { ...unsure.skin, skinUndertone: 'warm', confidence: 'medium', skinHex: '#C68E6E', statement: 'Your undertone is WARM (Warm Undertone)' } };
  sidecar.emit({ type: 'profile', sessionId: id, profile: sure });
  const second = await waitFor(() => seen.filter((e) => e.sessionId === id && e.type === 'session.skin')[1]);
  assert.equal(second.skinUndertone, 'warm');
  assert.equal(second.skinMeasurement.skinHex, '#C68E6E');
  assert.ok(second.palette.length > 0);
  assert.equal(openai.calls.length, 0, 'showing the undertone costs no tokens');
});
