import sharp from 'sharp';
import { buildApp } from '../src/app.js';
import { blackBackground, pasteOriginalHead } from '../src/lib/compose.js';
import { loadConfig } from '../src/config.js';
import { tempDir } from './helpers.js';

const W = 1024;
const H = 1536;
const svg = (body) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${body}</svg>`);
const toDataUrl = (buffer, mime = 'image/png') => `data:${mime};base64,${buffer.toString('base64')}`;

// A cut-out "person" on black, with the head at the top centre, plus the masks the sidecar would send.
export async function renderAssets() {
  const person = '<rect x="362" y="300" width="300" height="1150" fill="#3a4a6a"/><ellipse cx="512" cy="200" rx="90" ry="115" fill="#d8a888"/>';
  const image = await sharp(svg(`<rect width="100%" height="100%" fill="#000"/>${person}`)).jpeg().toBuffer();
  const personMask = await sharp(svg(`<rect width="100%" height="100%" fill="#000"/>${person.replace(/fill="#[0-9a-f]+"/g, 'fill="#fff"')}`))
    .greyscale()
    .png()
    .toBuffer();
  const keepMask = await sharp(svg('<rect width="100%" height="100%" fill="#000"/><ellipse cx="512" cy="200" rx="95" ry="120" fill="#fff"/>'))
    .greyscale()
    .png()
    .toBuffer();
  const editMask = await sharp(svg('<rect width="100%" height="100%" fill="#000" fill-opacity="1"/><rect x="330" y="300" width="364" height="1200" fill="#000" fill-opacity="0"/>'))
    .ensureAlpha()
    .png()
    .toBuffer();
  return {
    imageDataUrl: toDataUrl(image, 'image/jpeg'),
    personMaskDataUrl: toDataUrl(personMask),
    keepMaskDataUrl: toDataUrl(keepMask),
    editMaskDataUrl: toDataUrl(editMask),
    width: W,
    height: H
  };
}

// The "generated" try-on: same framing, new clothes colour, slightly different face.
export async function generatedImage({ body = '#6b7036', face = '#c99878' } = {}) {
  const buffer = await sharp(
    svg(`<rect width="100%" height="100%" fill="#101010"/><rect x="352" y="300" width="320" height="1150" fill="${body}"/><ellipse cx="512" cy="200" rx="90" ry="115" fill="${face}"/>`)
  )
    .png()
    .toBuffer();
  return buffer.toString('base64');
}

export async function bundleFor({ skin = { skinUndertone: 'warm', skinDepth: 'medium', confidence: 'medium' }, guidance = 'ready', heightCm = null } = {}) {
  return {
    captureId: 'cap123',
    source: 'still',
    guidance: { state: guidance, message: guidance === 'face_hidden' ? 'Face the mirror so I can see your face' : 'ok', ready: guidance === 'ready' },
    checks: { personCount: 1, fullBody: true, standing: true, faceVisible: true },
    profile: {
      skin: skin && { method: 'face-mesh', lab: { L: 60, a: 14, b: 22 }, ita: 20, hueAngle: 58, whiteBalance: 'gray-world', framesUsed: 1, ...skin },
      height: { cm: heightCm, method: heightCm ? 'calibrated' : 'none' },
      frame: { build: 'medium' }
    },
    render: await renderAssets(),
    faceEmbedding: new Array(128).fill(0.01)
  };
}

// Scriptable fake of the Python sidecar, including a live /events stream the test can push into.
const DEFAULT_COMPOSE = () => ({
  headPasted: true,
  handsPasted: ['left', 'right'],
  warp: { scale: 1, dx: 0, dy: 0 },
  alignment: { faceFound: true, shift: 0.002, scaleRatio: 1, aligned: true },
  similarity: 0.97,
  samePerson: true,
  threshold: 0.363
});

// compose(n) returns the sidecar's verdict for the nth /compose call; the image itself is composed
// with the real Node compositing so tests can check pixels. composeFails forces the local fallback.
export function fakeSidecar({
  bundle,
  compare = () => ({ faceFound: true, similarity: 0.97, samePerson: true, threshold: 0.363, shift: 0.002, scaleRatio: 1.0 }),
  compose = DEFAULT_COMPOSE,
  composeFails = false,
  down = false
} = {}) {
  const calls = [];
  const streams = new Set();
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  let compareCount = 0;
  let composeCount = 0;

  const fetchImpl = async (url, init = {}) => {
    const { pathname } = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method || 'GET', pathname, body });
    if (down) {
      throw new TypeError('fetch failed');
    }
    if (pathname === '/events') {
      let controller;
      const stream = new ReadableStream({ start: (c) => (controller = c) });
      const handle = { push: (event) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)) };
      streams.add(handle);
      init.signal?.addEventListener('abort', () => {
        streams.delete(handle);
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (pathname === '/health') {
      return json({ ok: true, camera: 'running' });
    }
    if (pathname === '/analyze' || pathname.startsWith('/captures/')) {
      return init.method === 'DELETE' ? json({ deleted: true }) : json(await bundle());
    }
    if (pathname === '/face/compare') {
      compareCount += 1;
      return json(compare(compareCount));
    }
    if (pathname === '/compose') {
      if (composeFails) {
        return json({ detail: 'compose crashed' }, 500);
      }
      composeCount += 1;
      const verdict = compose(composeCount);
      const generated = Buffer.from(body.generatedDataUrl.split(',')[1], 'base64');
      let image = verdict.headPasted
        ? await pasteOriginalHead({ generated, originalDataUrl: body.originalDataUrl, keepMaskDataUrl: body.keepMaskDataUrl })
        : generated;
      image = await blackBackground(image, (await renderAssets()).personMaskDataUrl);
      return json({ imageDataUrl: toDataUrl(image), ...verdict });
    }
    if (pathname === '/calibrate/undertone') {
      return json({ fitted: { neutral_hue: 55 }, trainedOn: body.samples.length, saved: body.save });
    }
    if (pathname === '/segment') {
      return json({ personFound: true, maskDataUrl: (await renderAssets()).personMaskDataUrl });
    }
    if (pathname === '/arm' || pathname === '/disarm') {
      return json({ armed: body?.sessionId || null });
    }
    return json({ detail: 'not found' }, 404);
  };

  return {
    fetchImpl,
    calls,
    callsTo: (pathname) => calls.filter((call) => call.pathname === pathname),
    emit: (event) => streams.forEach((stream) => stream.push(event)),
    connected: () => streams.size > 0
  };
}

export async function mirrorApp({ env = {}, openai, sidecar }) {
  const config = loadConfig({
    OPENAI_API_KEY: 'test-key',
    ARTIFACTS_DIR: tempDir(),
    RUNTIME_DIR: tempDir(),
    OPENAI_MAX_RETRIES: '0',
    PARTIAL_IMAGES: '0',
    RENDER_DRAFT: 'false',
    PREFETCH_OPTIONS: 'false',
    FINAL_QUALITY_EXPERIMENT: '',
    EARLY_DESIGN: 'true',
    ...env
  });
  const app = await buildApp(config, { logger: false, fetchImpl: openai.fetchImpl, sidecarFetch: sidecar.fetchImpl, spawnSidecar: false });
  await app.ready();
  return { app, config };
}

export async function waitFor(check, { timeoutMs = 4000, intervalMs = 20 } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) {
      return value;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export async function waitForRender(app, sessionId, key = '1.1') {
  return waitFor(async () => {
    const session = (await app.inject({ url: `/api/v2/sessions/${sessionId}` })).json();
    const render = session.renders?.find((r) => r.key === key);
    return render && ['done', 'failed'].includes(render.status) ? { session, render } : null;
  });
}

// Starts the app on a random port and records every SSE event from /api/v2/events. Pass the test
// context so the stream and server are closed even when an assertion fails.
export async function listenWithEvents(app, t, query = '') {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const seen = [];
  const controller = new AbortController();
  t.after(async () => {
    controller.abort();
    await app.close();
  });
  const response = await fetch(`${base}/api/v2/events${query}`, { signal: controller.signal });
  (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const data = buffer.slice(0, boundary).split('\n').find((line) => line.startsWith('data:'));
          buffer = buffer.slice(boundary + 2);
          if (data) {
            seen.push(JSON.parse(data.slice(5)));
          }
        }
      }
    } catch {
      // aborted when the test ends
    }
  })();
  await waitFor(() => seen.some((event) => event.type === 'hello'));
  return { base, seen };
}
