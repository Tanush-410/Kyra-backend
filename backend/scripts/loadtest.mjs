// Crowd simulation for the v2 pipeline: N visitors start sessions at once against the real
// orchestration (queue, budget, events, compose fallback), with OpenAI and the sidecar faked at
// realistic, time-scaled latencies. Usage: node scripts/loadtest.mjs [visitors=20] [timeScale=0.05] [renderConcurrency=2]
import sharp from 'sharp';
import { generatedImage, bundleFor, fakeSidecar, mirrorApp, waitFor } from '../test/mirror-helpers.js';

const visitors = Number(process.argv[2]) || 20;
const scale = Number(process.argv[3]) || 0.05;
const concurrency = process.argv[4] || '2';
// Measured on real runs: design ~11 s (first option ~5 s), image 17-50 s, draft ~10 s.
const LATENCY_MS = { design: 11_000, final: 30_000, finalJitter: 15_000, draft: 10_000 };

const DESIGN = {
  options: ['Teal', 'Navy', 'Olive'].map((name, i) => ({
    title: `${name} look`,
    summary: `${name} jacket ${i}.`,
    reasoning: 'Suits the palette.',
    items: [
      { category: 'top', name: `${name} jacket`, colorName: name, hex: ['#1E7A73', '#1F2A44', '#6B7036'][i], fit: 'slim', material: 'wool' },
      { category: 'bottom', name: 'Trousers', colorName: 'Cream', hex: '#EFE3C6', fit: 'straight', material: 'cotton' }
    ]
  }))
};

let inFlightImages = 0;
let peakImages = 0;
const generated = await generatedImage();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms * scale));
const fetchImpl = async (url, init) => {
  if (String(url).endsWith('/images/edits')) {
    const draft = init.body.get('quality') === 'low';
    inFlightImages += 1;
    peakImages = Math.max(peakImages, inFlightImages);
    await sleep(draft ? LATENCY_MS.draft : LATENCY_MS.final + Math.random() * LATENCY_MS.finalJitter);
    inFlightImages -= 1;
    return new Response(JSON.stringify({ data: [{ b64_json: generated }] }), { status: 200 });
  }
  await sleep(LATENCY_MS.design);
  return new Response(JSON.stringify({ output_text: JSON.stringify(DESIGN) }), { status: 200 });
};

const { app, config } = await mirrorApp({
  openai: { fetchImpl },
  sidecar: fakeSidecar({ bundle: () => bundleFor() }),
  env: { RENDER_CONCURRENCY: concurrency, RENDER_DRAFT: 'true', PREFETCH_OPTIONS: 'auto', RATE_LIMIT_MAX: '0', DAILY_BUDGET_USD: '1000', LOG_LEVEL: 'error' }
});
// A normally lit upload (the sidecar is faked, so only the local quality check sees it).
const photoBuffer = await sharp({ create: { width: 600, height: 900, channels: 3, background: { r: 120, g: 110, b: 100 } } })
  .composite([{ input: await sharp({ create: { width: 200, height: 600, channels: 3, background: { r: 30, g: 40, b: 60 } } }).png().toBuffer(), left: 200, top: 200 }])
  .jpeg()
  .toBuffer();
const photo = `data:image/jpeg;base64,${photoBuffer.toString('base64')}`;
const heapBefore = process.memoryUsage().heapUsed;

const t0 = Date.now();
const created = await Promise.all(
  Array.from({ length: visitors }, () =>
    app.inject({ method: 'POST', url: '/api/v2/sessions', payload: { style: 'party', consent: true, imageDataUrl: photo } })
  )
);
const ids = created.filter((r) => r.statusCode === 201).map((r) => r.json().sessionId);
if (ids.length < visitors) {
  console.log('refused:', created.find((r) => r.statusCode !== 201)?.body);
}
const doneAt = new Map();
await waitFor(
  async () => {
    for (const id of ids) {
      if (!doneAt.has(id)) {
        const session = (await app.inject(`/api/v2/sessions/${id}`)).json();
        if (session.renders?.find((r) => r.key === '1.1' && ['done', 'failed'].includes(r.status))) {
          doneAt.set(id, (Date.now() - t0) / scale / 1000);
        }
      }
    }
    return doneAt.size === ids.length;
  },
  { timeoutMs: 600_000, intervalMs: 50 }
);
const metrics = (await app.inject('/api/v2/metrics')).json();
for (const id of ids) {
  await app.inject({ method: 'DELETE', url: `/api/v2/sessions/${id}` });
}
const after = (await app.inject('/api/v2/metrics')).json();
global.gc?.();

const times = [...doneAt.values()].sort((a, b) => a - b);
const pct = (q) => times[Math.min(times.length - 1, Math.floor(q * times.length))].toFixed(0);
const realSeconds = (ms) => (ms / scale / 1000).toFixed(1);
console.log(`visitors: ${visitors} (time scale ${scale}; times below are real-world seconds)`);
console.log(`sessions created: ${ids.length}/${visitors}`);
console.log(`option-1 image on screen: p50 ${pct(0.5)} s, p90 ${pct(0.9)} s, last ${times.at(-1).toFixed(0)} s`);
console.log(`first image after a render starts (draft or preview) p50: ${realSeconds(metrics.steps.first_image?.p50Ms ?? 0)} s`);
console.log(`peak concurrent image calls: ${peakImages} (render concurrency ${config.renderConcurrency}; drafts run inside a render slot)`);
console.log(`render failures: ${metrics.counters.render_failures || 0}, background prefetches (only when the queue was empty): ${metrics.counters.prefetches || 0}`);
console.log(`estimated spend: $${metrics.budget.spentUsd}`);
console.log(`sessions left after visitors leave: ${after.activeSessions}; heap +${((process.memoryUsage().heapUsed - heapBefore) / 1e6).toFixed(1)} MB`);
await app.close();
