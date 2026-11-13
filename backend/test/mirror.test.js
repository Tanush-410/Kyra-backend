import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { fallbackOptions, enforceDesign } from '../src/lib/outfit-design.js';
import { buildPalette, fitGuidance } from '../src/lib/palette.js';
import { VISITOR_MESSAGES } from '../src/lib/mirror.js';
import { createLimiter } from '../src/lib/queue.js';
import { bundleFor, fakeSidecar, generatedImage, mirrorApp, waitFor, waitForRender } from './mirror-helpers.js';

const DESIGN = {
  options: [
    {
      title: 'Earthy smart',
      summary: 'Olive overshirt with cream tee and chocolate trousers.',
      reasoning: 'Olive and cream suit a warm undertone.',
      items: [
        { category: 'top', name: 'Cotton crew tee', colorName: 'Cream', hex: '#EFE3C6', fit: 'regular', material: 'cotton' },
        { category: 'bottom', name: 'Pleated trousers', colorName: 'Chocolate', hex: '#5A3A24', fit: 'relaxed', material: 'wool' },
        { category: 'shoes', name: 'Suede loafers', colorName: 'Hot pink', hex: '#FF00AA', fit: '', material: 'suede' }
      ]
    },
    {
      title: 'Teal accent',
      summary: 'Teal knit polo with navy chinos.',
      reasoning: 'Teal flatters medium warm skin.',
      items: [
        { category: 'top', name: 'Knit polo', colorName: 'Teal', hex: '#1E7A73', fit: 'slim', material: 'knit' },
        { category: 'bottom', name: 'Chinos', colorName: 'Navy', hex: '#1F2A44', fit: 'straight', material: 'cotton' }
      ]
    },
    { title: 'Broken', summary: 'Only shoes.', reasoning: '', items: [{ category: 'shoes', name: 'Boots', colorName: 'Brown', hex: '#4E3423', fit: '', material: '' }] }
  ]
};

function sseResponse(chunks, delayMs) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      controller.close();
    }
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function mirrorOpenAI({ design = DESIGN, failDesign = false, stream = false, streamText = false, images } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/images/edits')) {
      const form = init.body;
      calls.push({ kind: 'image', prompt: form.get('prompt'), hasMask: Boolean(form.get('mask')), stream: form.get('stream') });
      const base64 = images ? await images(calls.filter((c) => c.kind === 'image').length) : await generatedImage();
      if (stream && form.get('stream') === 'true') {
        const partial = await generatedImage({ body: '#333333' });
        const body = [
          `event: image_edit.partial_image\ndata: ${JSON.stringify({ type: 'image_edit.partial_image', b64_json: partial, partial_image_index: 0 })}\n\n`,
          `event: image_edit.completed\ndata: ${JSON.stringify({ type: 'image_edit.completed', b64_json: base64 })}\n\n`
        ].join('');
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response(JSON.stringify({ data: [{ b64_json: base64 }] }), { status: 200 });
    }
    const payload = JSON.parse(init.body);
    calls.push({ kind: 'text', payload, text: payload.input[0].content[0].text });
    if (failDesign) {
      return new Response(JSON.stringify({ error: { message: 'upstream down' } }), { status: 500 });
    }
    if (streamText && payload.stream) {
      // Deliver the JSON in slices so option 1 completes well before the rest.
      const text = JSON.stringify(design);
      const cut = text.indexOf('{"title":"Teal accent"');
      const deltas = [text.slice(0, cut), text.slice(cut, cut + 40), text.slice(cut + 40)];
      return sseResponse(
        [...deltas.map((delta) => `data: ${JSON.stringify({ type: 'response.output_text.delta', delta })}\n\n`), `data: ${JSON.stringify({ type: 'response.completed' })}\n\n`],
        150
      );
    }
    return new Response(JSON.stringify({ output_text: JSON.stringify(design) }), { status: 200 });
  };
  return { fetchImpl, calls, callsOf: (kind) => calls.filter((call) => call.kind === kind) };
}

const startUpload = (app, extra = {}) =>
  app.inject({ method: 'POST', url: '/api/v2/sessions', payload: { style: 'smart casual', consent: true, imageDataUrl: 'PLACEHOLDER', ...extra } });

async function photo() {
  const buffer = await sharp({ create: { width: 600, height: 900, channels: 3, background: { r: 120, g: 110, b: 100 } } })
    .composite([{ input: await sharp({ create: { width: 200, height: 600, channels: 3, background: { r: 30, g: 40, b: 60 } } }).png().toBuffer(), left: 200, top: 200 }])
    .jpeg()
    .toBuffer();
  return `data:image/jpeg;base64,${buffer.toString('base64')}`;
}

test('palette rules: same profile always gives the same palette, and avoided colours are removed', () => {
  const warm = buildPalette({ skinUndertone: 'warm', skinDepth: 'medium' });
  assert.deepEqual(warm, buildPalette({ skinUndertone: 'warm', skinDepth: 'medium' }));
  assert.equal(warm.palette[0].name, 'Terracotta');
  const cool = buildPalette({ skinUndertone: 'cool', skinDepth: 'deep' });
  assert.notDeepEqual(cool.palette, warm.palette);
  const noOlive = buildPalette({ skinUndertone: 'warm', skinDepth: 'medium' }, ['olive', 'navy']);
  assert.equal(noOlive.allowed.some((c) => /olive|navy/i.test(c.name)), false);
  assert.equal(buildPalette({ skinUndertone: null, skinDepth: null }).basis.assumed, true);
  assert.match(fitGuidance({ heightImpression: 'petite', build: 'broad' }).join(' '), /High-rise[\s\S]*V-necks/i);
});

test('design enforcement snaps colours into the palette and drops incomplete outfits', () => {
  const palette = buildPalette({ skinUndertone: 'warm', skinDepth: 'medium' });
  const options = enforceDesign(DESIGN.options, palette.allowed);
  assert.equal(options.length, 2, 'option without top+bottom is dropped');
  const shoes = options[0].items.find((item) => item.category === 'shoes');
  assert.ok(palette.allowed.some((c) => c.hex === shoes.hex), 'hot pink snapped into palette');
  assert.equal(shoes.recoloured, true);
  const avoided = enforceDesign(DESIGN.options, palette.allowed, ['teal']);
  assert.equal(avoided.flatMap((o) => o.items).some((item) => /teal/i.test(item.colorName)), false);
});

test('incremental parser yields each option as soon as its JSON object closes', async () => {
  const { completeOptionObjects, designOptions } = await import('../src/lib/outfit-design.js');
  const text = JSON.stringify({ options: [{ title: 'a "quoted} brace', items: [] }, { title: 'b', items: [] }] });
  assert.equal(completeOptionObjects(text.slice(0, 20)).length, 0);
  assert.equal(completeOptionObjects(text.slice(0, text.indexOf('{"title":"b"'))).length, 1);
  assert.equal(JSON.parse(completeOptionObjects(text)[0]).title, 'a "quoted} brace');

  const seen = [];
  const full = JSON.stringify(DESIGN);
  const fakeOpenAI = {
    async respondStream({ onText }) {
      for (let end = 50; end < full.length; end += 50) {
        onText(full.slice(0, end));
        seen.push(`text:${end}`);
      }
      return full;
    }
  };
  const palette = buildPalette({ skinUndertone: 'warm', skinDepth: 'medium' });
  const options = await designOptions({
    openai: fakeOpenAI,
    onOption: (option) => seen.push(`option:${option.option}`),
    request: { style: 'casual', profile: {}, palette, fitLines: [], preferences: { avoidColors: [], modesty: 'standard' }, previous: [], feedback: '' }
  });
  assert.equal(options.length, 2);
  assert.ok(seen.indexOf('option:1') < seen.indexOf('option:2'));
  assert.ok(seen.indexOf('option:1') < seen.length - 5, 'option 1 arrives long before the stream ends');
});

test('fallback options are complete outfits from the palette', () => {
  const palette = buildPalette({ skinUndertone: 'cool', skinDepth: 'light' });
  const options = fallbackOptions({ style: 'wedding guest', gender: 'female', palette, preferences: { avoidColors: [] } });
  assert.equal(options.length, 3);
  assert.ok(options.every((o) => o.items.some((item) => item.category === 'onepiece')));
  assert.ok(options.flatMap((o) => o.items).every((item) => palette.allowed.some((c) => c.hex === item.hex)));
});

test('limiter runs at most N tasks and reports queue positions', async () => {
  const limiter = createLimiter(1);
  const positions = [];
  let release;
  const first = limiter.run(() => new Promise((resolve) => (release = resolve)));
  const second = limiter.run(async () => 'second', (position) => positions.push(position));
  assert.deepEqual(limiter.stats(), { running: 1, waiting: 1, concurrency: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  release('first');
  assert.equal(await first, 'first');
  assert.equal(await second, 'second');
  assert.equal(positions[0], 1, 'waits as number 1 in line');
  assert.equal(positions.at(-1), 0, 'then starts');
});

test('upload session: measured profile → palette → one structured design call → masked render with head pasted', async () => {
  const sidecar = fakeSidecar({ bundle: () => bundleFor() });
  const openai = mirrorOpenAI();
  const { app } = await mirrorApp({ openai, sidecar });

  const created = await startUpload(app, { imageDataUrl: await photo(), heightCm: 185 });
  assert.equal(created.statusCode, 201, created.body);
  const { session, render } = await waitForRender(app, created.json().sessionId);

  assert.equal(session.profile.skinUndertone, 'warm');
  assert.equal(session.profile.heightImpression, 'tall');
  assert.equal(session.profile.heightSource, 'visitor');
  assert.equal(session.palette[0].name, 'Terracotta');
  assert.equal(session.rounds[0].source, 'ai');
  assert.equal(session.rounds[0].options.length, 2);

  const textCalls = openai.callsOf('text');
  assert.equal(textCalls.length, 1, 'exactly one LLM call before the image');
  assert.equal(textCalls[0].payload.text.format.type, 'json_schema');
  assert.equal(textCalls[0].payload.input[0].content.length, 1, 'design call sends no image');
  assert.match(textCalls[0].text, /Terracotta #C8664A/);
  assert.ok(textCalls[0].text.length < 900, `design prompt stays short (${textCalls[0].text.length} chars)`);

  const image = openai.callsOf('image')[0];
  assert.equal(image.hasMask, false, 'unmasked by default');
  assert.match(image.prompt, /Keep pose, framing, body shape, face, hair and skin tone exactly/);

  assert.equal(render.status, 'done');
  assert.equal(render.faceCheck.headPasted, true);
  assert.equal(render.faceCheck.passed, true);
  assert.equal(render.faceCheck.method, 'sface-embedding');
  assert.deepEqual(render.faceCheck.handsPasted, ['left', 'right']);
  assert.equal(sidecar.callsTo('/compose').length, 1, 'one sidecar call aligns, pastes, blacks out and checks');

  const final = await sharp(Buffer.from(render.imageDataUrl.split(',')[1], 'base64')).raw().toBuffer({ resolveWithObject: true });
  const pixel = (x, y) => [...final.data.subarray((y * final.info.width + x) * final.info.channels, (y * final.info.width + x) * final.info.channels + 3)];
  // The render's background is #101010, so pure black proves the background was blacked out.
  assert.deepEqual(pixel(10, 10), [0, 0, 0], 'background is pure black');
  const headPixel = pixel(512, 200);
  assert.ok(Math.abs(headPixel[0] - 0xd8) < 12, `head comes from the original capture, got ${headPixel}`);
  const bodyPixel = pixel(512, 900);
  assert.ok(Math.abs(bodyPixel[0] - 0x6b) < 12 && Math.abs(bodyPixel[1] - 0x70) < 12, `body comes from the render (new clothes), got ${bodyPixel}`);
  await app.close();
});

test('RENDER_MASK=true sends the clothing mask and a mask-specific prompt', async () => {
  const openai = mirrorOpenAI();
  const { app } = await mirrorApp({ openai, sidecar: fakeSidecar({ bundle: () => bundleFor() }), env: { RENDER_MASK: 'true' } });
  const created = await startUpload(app, { imageDataUrl: await photo() });
  await waitForRender(app, created.json().sessionId);
  assert.equal(openai.callsOf('image')[0].hasMask, true);
  assert.match(openai.callsOf('image')[0].prompt, /Edit only the transparent mask area/);
  await app.close();
});

test('a render the sidecar cannot align keeps its own face, and with RENDER_RETRIES=1 a failed identity check regenerates once', async () => {
  const sidecar = fakeSidecar({
    bundle: () => bundleFor(),
    compose: (n) => ({ headPasted: false, handsPasted: [], warp: null, alignment: { shift: 0.2 }, similarity: n === 1 ? 0.2 : 0.8, samePerson: n !== 1, threshold: 0.363 })
  });
  const openai = mirrorOpenAI();
  const { app } = await mirrorApp({ openai, sidecar, env: { RENDER_RETRIES: '1' } });
  const created = await startUpload(app, { imageDataUrl: await photo() });
  const { render } = await waitForRender(app, created.json().sessionId);
  assert.equal(openai.callsOf('image').length, 2);
  assert.equal(render.faceCheck.headPasted, false);
  assert.equal(render.faceCheck.passed, true);
  assert.equal(render.faceCheck.attempts, 2);
  await app.close();
});

test('if the sidecar compose step fails, the render is finished locally (head paste + check)', async () => {
  const sidecar = fakeSidecar({ bundle: () => bundleFor(), composeFails: true });
  const { app } = await mirrorApp({ openai: mirrorOpenAI(), sidecar });
  const created = await startUpload(app, { imageDataUrl: await photo() });
  const { render } = await waitForRender(app, created.json().sessionId);
  assert.equal(render.status, 'done');
  assert.equal(render.faceCheck.headPasted, true);
  assert.equal(sidecar.callsTo('/segment').length, 1, 'local path segments for the black background');
  await app.close();
});

test('upload rejected when the sidecar cannot see a face, and 503 when the sidecar is down', async () => {
  const openai = mirrorOpenAI();
  const blocked = await mirrorApp({ openai, sidecar: fakeSidecar({ bundle: () => bundleFor({ guidance: 'face_hidden' }) }) });
  const rejected = await startUpload(blocked.app, { imageDataUrl: await photo() });
  assert.equal(rejected.statusCode, 422);
  assert.match(rejected.json().error, /Face the mirror/);
  await blocked.app.close();

  const down = await mirrorApp({ openai, sidecar: fakeSidecar({ down: true }) });
  assert.equal((await startUpload(down.app, { imageDataUrl: await photo() })).statusCode, 503);
  await down.app.close();
  assert.equal(openai.calls.length, 0);
});

test('AI outage falls back to rule-based options; budget cap gives text-only without images', async () => {
  const outage = mirrorOpenAI({ failDesign: true });
  const first = await mirrorApp({ openai: outage, sidecar: fakeSidecar({ bundle: () => bundleFor() }) });
  const created = await startUpload(first.app, { imageDataUrl: await photo() });
  const { session } = await waitForRender(first.app, created.json().sessionId);
  assert.equal(session.rounds[0].source, 'fallback');
  assert.equal(session.rounds[0].options.length, 3);
  await first.app.close();

  const capped = mirrorOpenAI();
  const second = await mirrorApp({ openai: capped, sidecar: fakeSidecar({ bundle: () => bundleFor() }), env: { DAILY_BUDGET_USD: '0.05' } });
  const id = (await startUpload(second.app, { imageDataUrl: await photo() })).json().sessionId;
  const result = await waitForRender(second.app, id);
  assert.equal(result.render.status, 'failed');
  assert.deepEqual(result.session.degraded, { mode: 'text-only', reason: 'budget', message: VISITOR_MESSAGES.budget });
  assert.equal(capped.callsOf('image').length, 0, 'no paid image call once the cap would be exceeded');
  const metrics = (await second.app.inject('/api/v2/metrics')).json();
  assert.equal(metrics.budget.calls.text, 1);
  await second.app.close();
});

test('redesign: feedback and earlier options go into one new design call; other options render on demand', async () => {
  const openai = mirrorOpenAI();
  const { app } = await mirrorApp({ openai, sidecar: fakeSidecar({ bundle: () => bundleFor() }) });
  const id = (await startUpload(app, { imageDataUrl: await photo() })).json().sessionId;
  await waitForRender(app, id);

  const second = await app.inject({ method: 'POST', url: `/api/v2/sessions/${id}/render`, payload: { round: 1, option: 2 } });
  assert.equal(second.statusCode, 202);
  await waitForRender(app, id, '1.2');

  const redesign = await app.inject({ method: 'POST', url: `/api/v2/sessions/${id}/redesign`, payload: { feedback: 'more colour', preferences: { avoidColors: ['navy'] } } });
  assert.equal(redesign.statusCode, 200, redesign.body);
  const text = openai.callsOf('text')[1].text;
  assert.match(text, /more colour/);
  assert.match(text, /Already shown, do not repeat:[\s\S]*Olive overshirt/);
  assert.doesNotMatch(text.split('; neutrals ')[1].split('\n')[0], /Navy/);
  await waitForRender(app, id, '2.1');
  assert.equal(openai.callsOf('image').length, 3);
  assert.equal((await app.inject({ method: 'POST', url: `/api/v2/sessions/${id}/render`, payload: { round: 9, option: 1 } })).statusCode, 404);
  await app.close();
});

test('keep: only a requested look is saved, behind an unguessable link with a QR code', async () => {
  const { app } = await mirrorApp({ openai: mirrorOpenAI(), sidecar: fakeSidecar({ bundle: () => bundleFor() }) });
  const id = (await startUpload(app, { imageDataUrl: await photo() })).json().sessionId;
  await waitForRender(app, id);
  const kept = await app.inject({ method: 'POST', url: `/api/v2/sessions/${id}/keep`, payload: { round: 1, option: 1 } });
  assert.equal(kept.statusCode, 200, kept.body);
  const { url, qrDataUrl } = kept.json();
  assert.match(url, /\/looks\/[0-9a-f]{32}$/);
  assert.match(qrDataUrl, /^data:image\/png;base64,/);
  const page = await app.inject(new URL(url).pathname);
  assert.match(page.body, /<img src="\/looks\/[0-9a-f]{32}\.png"/);
  const png = await app.inject(`${new URL(url).pathname}.png`);
  assert.equal(png.headers['content-type'], 'image/png');
  assert.equal((await app.inject('/looks/00000000000000000000000000000000')).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: `/api/v2/sessions/${id}/keep`, payload: { round: 1, option: 3 } })).statusCode, 409);
  await app.close();
});

test('camera flow over live events: arm → capture event → options → partial previews → done → visitor leaves', async (t) => {
  const sidecar = fakeSidecar({ bundle: () => bundleFor({ heightCm: 172 }) });
  const openai = mirrorOpenAI({ stream: true, streamText: true });
  const { app } = await mirrorApp({ openai, sidecar, env: { PARTIAL_IMAGES: '2', LEAVE_GRACE_MS: '50' } });
  const controller = new AbortController();
  t.after(async () => {
    controller.abort();
    await app.close();
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  await waitFor(() => sidecar.connected());

  const seen = [];
  const response = await fetch(`${base}/api/v2/events`, { signal: controller.signal });
  (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        for (const block of buffer.split('\n\n').slice(0, -1)) {
          const data = block.split('\n').find((line) => line.startsWith('data:'));
          if (data) {
            seen.push(JSON.parse(data.slice(5)));
          }
        }
        buffer = buffer.slice(buffer.lastIndexOf('\n\n') + 2);
      }
    } catch {
      // aborted at the end of the test
    }
  })();
  await waitFor(() => seen.some((e) => e.type === 'hello'));

  const created = await fetch(`${base}/api/v2/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ style: 'office', consent: true }) });
  const { sessionId, status } = await created.json();
  assert.equal(status, 'waiting_for_capture');
  assert.equal(sidecar.callsTo('/arm')[0].body.sessionId, sessionId);

  sidecar.emit({ type: 'state', state: 'too_close', message: 'Step back so I can see you from head to toe', ready: false });
  await waitFor(() => seen.some((e) => e.type === 'perception' && e.state === 'too_close'));

  sidecar.emit({ type: 'capture', sessionId, captureId: 'cap123' });
  const profile = await waitFor(() => seen.find((e) => e.type === 'session.profile'));
  assert.equal(profile.profile.heightCm, 172);
  assert.equal(profile.profile.heightSource, 'calibrated-camera');
  await waitFor(() => seen.find((e) => e.type === 'session.options'));
  const partial = await waitFor(() => seen.find((e) => e.type === 'session.render.partial'));
  assert.equal(partial.imageDataUrl, null, 'a stream not scoped to the session carries no visitor images');
  await waitFor(() => seen.find((e) => e.type === 'session.render.done'));
  assert.equal(openai.callsOf('image')[0].stream, 'true');
  assert.equal(sidecar.callsTo('/captures/cap123').filter((c) => c.method === 'DELETE').length, 1, 'capture deleted from the sidecar once fetched');

  sidecar.emit({ type: 'presence', present: false });
  await waitFor(() => seen.find((e) => e.type === 'session.leaving'));
  const ended = await waitFor(() => seen.find((e) => e.type === 'session.ended'));
  assert.equal(ended.reason, 'visitor_left');
  assert.equal((await fetch(`${base}/api/v2/sessions/${sessionId}`)).status, 404);

  const order = seen.filter((e) => e.sessionId === sessionId).map((e) => e.type);
  assert.ok(order.indexOf('session.profile') < order.indexOf('session.option'));
  assert.ok(order.indexOf('session.render.started') < order.indexOf('session.options'), 'option 1 renders while the rest is still being written');
  assert.equal(order.filter((type) => type === 'session.option').length, 2);
  assert.ok(order.indexOf('session.option') < order.indexOf('session.render.done'));
});

test('events accept ?token= when API_TOKEN is set; metrics report step timings', async () => {
  const { app } = await mirrorApp({ openai: mirrorOpenAI(), sidecar: fakeSidecar({ bundle: () => bundleFor() }), env: { API_TOKEN: 'tok' } });
  assert.equal((await app.inject('/api/v2/metrics')).statusCode, 401);
  assert.equal((await app.inject('/api/v2/metrics?token=tok')).statusCode, 200);
  const auth = { authorization: 'Bearer tok' };
  const id = (await app.inject({ method: 'POST', url: '/api/v2/sessions', headers: auth, payload: { style: 'casual', consent: true, imageDataUrl: await photo() } })).json().sessionId;
  await waitFor(async () => (await app.inject({ url: `/api/v2/sessions/${id}`, headers: auth })).json().renders?.[0]?.status === 'done');
  const metrics = (await app.inject({ url: '/api/v2/metrics', headers: auth })).json();
  assert.ok(metrics.steps.design.count >= 1);
  assert.ok(metrics.steps.render_total.count >= 1);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/v2/sessions/${id}`, headers: auth })).statusCode, 200);
  await app.close();
});
