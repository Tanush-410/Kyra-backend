import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

export const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

export function tempDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'kyra-test-'));
}

export const FACE_BOX = { x: 0.4, y: 0.1, width: 0.2, height: 0.15 };

// A 600x900 "person": grey room, dark clothing block, and a flat skin-coloured face patch at FACE_BOX.
export async function syntheticPerson({ skin = [205, 160, 120], background = [128, 128, 128], cast = [1, 1, 1] } = {}) {
  const width = 600;
  const height = 900;
  const applyCast = ([r, g, b]) => ({
    r: Math.min(255, Math.round(r * cast[0])),
    g: Math.min(255, Math.round(g * cast[1])),
    b: Math.min(255, Math.round(b * cast[2]))
  });
  const block = (w, h, colour) => ({ create: { width: w, height: h, channels: 3, background: applyCast(colour) } });

  const buffer = await sharp(block(width, height, background))
    .composite([
      { input: await sharp(block(240, 560, [40, 45, 60])).png().toBuffer(), left: 180, top: 260 },
      { input: await sharp(block(200, 120, [235, 235, 235])).png().toBuffer(), left: 20, top: 700 },
      {
        input: await sharp(block(FACE_BOX.width * width, FACE_BOX.height * height, skin)).png().toBuffer(),
        left: FACE_BOX.x * width,
        top: FACE_BOX.y * height
      }
    ])
    .jpeg({ quality: 95 })
    .toBuffer();
  return { buffer, dataUrl: `data:image/jpeg;base64,${buffer.toString('base64')}` };
}

export async function solidImage(colour, size = 600) {
  const buffer = await sharp({
    create: { width: size, height: size, channels: 3, background: { r: colour[0], g: colour[1], b: colour[2] } }
  })
    .jpeg()
    .toBuffer();
  return { buffer, dataUrl: `data:image/jpeg;base64,${buffer.toString('base64')}` };
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

// Routes OpenAI calls by prompt content. Each handler may be a value or a function of (callIndex).
export function mockOpenAI(handlers = {}) {
  const calls = [];
  const counters = {};
  const resolve = (kind, fallback) => {
    counters[kind] = (counters[kind] || 0) + 1;
    const handler = handlers[kind] ?? fallback;
    return typeof handler === 'function' ? handler(counters[kind]) : handler;
  };

  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/images/edits')) {
      calls.push({ kind: 'image', prompt: init.body.get('prompt') });
      const response = resolve('image', { data: [{ b64_json: TINY_PNG_BASE64 }] });
      return response instanceof Response ? response : jsonResponse(response);
    }

    const text = JSON.parse(init.body).input[0].content[0].text;
    const kind = text.includes('photo check')
      ? 'assess'
      : text.includes('Design one complete outfit')
        ? 'design'
        : text.includes('Judge only whether the face')
          ? 'faceCheck'
          : 'review';
    calls.push({ kind, text });

    const defaults = {
      assess: {
        usable: true,
        reason: '',
        personCount: 1,
        singleProminentPerson: true,
        fullBodyVisible: true,
        faceVisible: true,
        lighting: 'good',
        faceBox: FACE_BOX,
        estimate: { skinUndertone: 'neutral', skinDepth: 'medium', heightImpression: 'average', frame: 'medium' },
        currentOutfit: 'navy t-shirt and jeans'
      },
      design: {
        palette: [{ name: 'Olive', hex: '#556b2f' }],
        outfit: {
          summary: 'Olive blazer over cream shirt.',
          reasoning: 'Olive suits warm undertones.',
          items: [
            { category: 'top', name: 'Cream oxford shirt', color: 'Cream', hex: '#F5F0E1', fit: 'slim', material: 'cotton' },
            { category: 'bottom', name: 'Charcoal trousers', color: 'Charcoal', hex: '#333333', fit: 'tailored', material: 'wool' },
            { category: 'shoes', name: 'Brown loafers', color: 'Brown', hex: '#5C4033', fit: '', material: 'leather' }
          ]
        }
      },
      faceCheck: { samePerson: true, score: 0.92, issues: '' },
      review: { score: 7, summary: 'Clean casual look.', visibleRegions: { top: true }, cards: [] }
    };
    const response = resolve(kind, defaults[kind]);
    return response instanceof Response ? response : jsonResponse({ output_text: JSON.stringify(response) });
  };

  return { fetchImpl, calls, callsOf: (kind) => calls.filter((call) => call.kind === kind) };
}

export async function testApp({ env = {}, handlers } = {}) {
  const artifactsDir = tempDir();
  const config = loadConfig({
    OPENAI_API_KEY: 'test-key',
    ARTIFACTS_DIR: artifactsDir,
    WARDROBE_DIR: tempDir(),
    OPENAI_MAX_RETRIES: '0',
    RETENTION_HOURS: '24',
    RUNTIME_DIR: tempDir(),
    SIDECAR_URL: 'http://127.0.0.1:1',
    ...env
  });
  const openai = mockOpenAI(handlers);
  const app = await buildApp(config, { logger: false, fetchImpl: openai.fetchImpl, spawnSidecar: false });
  return { app, config, openai, artifactsDir };
}

export async function waitForJob(app, jobId, headers = {}) {
  for (let i = 0; i < 100; i += 1) {
    const job = (await app.inject({ url: `/api/virtual-tryon/${jobId}`, headers })).json();
    if (job.status !== 'processing') {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('job did not settle');
}
