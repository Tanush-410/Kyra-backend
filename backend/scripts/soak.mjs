// Soak test: waves of visitors for a while, with some image failures mixed in, against the real
// orchestration (OpenAI and the sidecar faked, time-scaled). Fails if memory keeps growing or sessions
// pile up, which a single load-test burst cannot show.
// Usage: npm run soak -- [minutes=10] [visitorsPerWave=6] [imageFailureRate=0.1]
import sharp from 'sharp';
import { bundleFor, fakeSidecar, generatedImage, mirrorApp, waitFor } from '../test/mirror-helpers.js';

const minutes = Number(process.argv[2]) || 10;
const perWave = Number(process.argv[3]) || 6;
const failureRate = Number(process.argv[4] ?? 0.1);
const MAX_HEAP_GROWTH_MB = 40;

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
const generated = await generatedImage();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fetchImpl = async (url) => {
  if (String(url).endsWith('/images/edits')) {
    await sleep(200 + Math.random() * 400);
    if (Math.random() < failureRate) {
      return new Response(JSON.stringify({ error: { message: 'upstream error' } }), { status: 500 });
    }
    return new Response(JSON.stringify({ data: [{ b64_json: generated }] }), { status: 200 });
  }
  await sleep(150);
  return new Response(JSON.stringify({ output_text: JSON.stringify(DESIGN) }), { status: 200 });
};

const sidecar = fakeSidecar({ bundle: () => bundleFor() });
const { app } = await mirrorApp({
  openai: { fetchImpl },
  sidecar,
  env: { RENDER_CONCURRENCY: '3', PREFETCH_OPTIONS: 'auto', RATE_LIMIT_MAX: '0', DAILY_BUDGET_USD: '0', OPENAI_MAX_RETRIES: '0' }
});
const block = (width, height, colour) => ({ create: { width, height, channels: 3, background: colour } });
const person = await sharp(block(200, 600, { r: 30, g: 40, b: 60 })).png().toBuffer();
const photoBuffer = await sharp(block(600, 900, { r: 120, g: 110, b: 100 })).composite([{ input: person, left: 200, top: 200 }]).jpeg().toBuffer();
const photo = `data:image/jpeg;base64,${photoBuffer.toString('base64')}`;

const heapMb = () => {
  global.gc?.();
  return process.memoryUsage().heapUsed / 1e6;
};
const samples = [];
const deadline = Date.now() + minutes * 60_000;
let visitors = 0;
let wave = 0;
while (Date.now() < deadline) {
  wave += 1;
  const created = await Promise.all(
    Array.from({ length: perWave }, () => app.inject({ method: 'POST', url: '/api/v2/sessions', payload: { style: 'party', consent: true, imageDataUrl: photo } }))
  );
  const ids = created.filter((r) => r.statusCode === 201).map((r) => r.json().sessionId);
  visitors += ids.length;
  await waitFor(
    async () => {
      for (const id of ids) {
        const session = (await app.inject(`/api/v2/sessions/${id}`)).json();
        if (!session.renders?.some((r) => r.key === '1.1' && ['done', 'failed'].includes(r.status))) {
          return false;
        }
      }
      return true;
    },
    { timeoutMs: 60_000, intervalMs: 50 }
  );
  // Each visitor asks for one more look, then leaves.
  await Promise.all(ids.map((id) => app.inject({ method: 'POST', url: `/api/v2/sessions/${id}/next` })));
  await sleep(800);
  await Promise.all(ids.map((id) => app.inject({ method: 'DELETE', url: `/api/v2/sessions/${id}` })));
  await waitFor(async () => (await app.inject('/api/v2/metrics')).json().queue.running === 0, { timeoutMs: 60_000 });
  sidecar.calls.length = 0; // the fake records every call (with images) for tests; not app memory
  samples.push(heapMb());
  process.stdout.write(`wave ${wave}: ${visitors} visitors, heap ${samples.at(-1).toFixed(1)} MB\n`);
}

const metrics = (await app.inject('/api/v2/metrics')).json();
await app.close();
const baseline = samples[Math.min(1, samples.length - 1)]; // after the first wave warms caches
const growth = samples.at(-1) - baseline;
console.log(`\n${visitors} visitors in ${wave} waves over ${minutes} min`);
console.log(`renders: ${metrics.steps.render_total?.count ?? 0} done, ${metrics.counters.render_failures ?? 0} failed (injected rate ${failureRate})`);
console.log(`sessions still open: ${metrics.activeSessions}; heap ${baseline.toFixed(1)} → ${samples.at(-1).toFixed(1)} MB (${growth >= 0 ? '+' : ''}${growth.toFixed(1)})`);
if (metrics.activeSessions > 0 || growth > MAX_HEAP_GROWTH_MB) {
  console.error('FAIL: sessions or memory are not being released');
  process.exit(1);
}
console.log(global.gc ? 'PASS' : 'PASS (run with --expose-gc for exact heap numbers)');
