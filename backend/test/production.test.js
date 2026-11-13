// Production hardening: secrets out of logs, operator-only routes, readiness, graceful drain, per-session
// rate limits, text-only fallback when images fail, subject changes, alerts, log files, metrics persistence.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import sharp from 'sharp';
import { createAlerts } from '../src/lib/alerts.js';
import { createLogStream, redactUrl } from '../src/lib/logfile.js';
import { createMetrics } from '../src/lib/metrics.js';
import { VISITOR_MESSAGES } from '../src/lib/mirror.js';
import { restartPlan, sidecarEnv } from '../src/lib/sidecar.js';
import { allowedHostNames, hostName } from '../src/app.js';
import { ensureTokens } from '../src/lib/secrets.js';
import { promptText } from '../src/lib/normalize.js';
import { listenWithEvents } from './mirror-helpers.js';
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

// OpenAI fake: imageStatus(n) gives the HTTP status for the nth image call (200 = success).
function openaiFake({ imageStatus = () => 200 } = {}) {
  let images = 0;
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/images/edits')) {
      images += 1;
      const status = imageStatus(images);
      if (status !== 200) {
        return new Response(JSON.stringify({ error: { message: `internal detail ${status}` } }), { status });
      }
      return new Response(JSON.stringify({ data: [{ b64_json: await generatedImage() }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ output_text: JSON.stringify(DESIGN) }), { status: 200 });
  };
  return { fetchImpl, imageCalls: () => images };
}

async function photo() {
  const block = (width, height, colour) => ({ create: { width, height, channels: 3, background: colour } });
  const person = await sharp(block(200, 600, { r: 30, g: 40, b: 60 })).png().toBuffer();
  const buffer = await sharp(block(600, 900, { r: 120, g: 110, b: 100 })).composite([{ input: person, left: 200, top: 200 }]).jpeg().toBuffer();
  return `data:image/jpeg;base64,${buffer.toString('base64')}`;
}
const upload = async (app, headers = {}) =>
  app.inject({ method: 'POST', url: '/api/v2/sessions', headers, payload: { style: 'casual', consent: true, imageDataUrl: await photo() } });

test('request logs never contain the API token or a kept look\'s share token', async () => {
  assert.equal(redactUrl('/api/v2/events?sessionId=a&token=s3cret'), '/api/v2/events?sessionId=a&token=[redacted]');
  assert.equal(redactUrl(`/looks/${'ab'.repeat(16)}.png`), '/looks/[redacted].png');

  const lines = [];
  const stream = new Writable({ write: (chunk, _encoding, done) => (lines.push(String(chunk)), done()) });
  const { buildApp } = await import('../src/app.js');
  const { loadConfig } = await import('../src/config.js');
  const config = loadConfig({ OPENAI_API_KEY: 'k', API_TOKEN: 's3cret', ARTIFACTS_DIR: tempDir(), RUNTIME_DIR: tempDir(), SIDECAR_URL: 'http://127.0.0.1:1' });
  const app = await buildApp(config, { logger: { level: 'info', stream }, spawnSidecar: false, sidecarFetch: fakeSidecar({ bundle: () => bundleFor() }).fetchImpl });
  await app.inject('/api/v2/metrics?token=s3cret');
  await app.inject(`/looks/${'cd'.repeat(16)}`);
  await app.close();
  const log = lines.join('');
  assert.match(log, /token=\[redacted\]/);
  assert.ok(!log.includes('s3cret') && !log.includes('cd'.repeat(16)), 'secrets must not reach the log');
});

test('with OPERATOR_TOKEN, calibration and metrics need it; the kiosk token cannot use them', async () => {
  const { app } = await mirrorApp({ openai: openaiFake(), sidecar: fakeSidecar({ bundle: () => bundleFor() }), env: { API_TOKEN: 'kiosk', OPERATOR_TOKEN: 'ops' } });
  const as = (token) => ({ authorization: `Bearer ${token}` });
  assert.equal((await app.inject({ url: '/api/v2/metrics', headers: as('kiosk') })).statusCode, 401);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/v2/calibration', headers: as('kiosk') })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/v2/metrics', headers: as('ops') })).statusCode, 200);
  assert.equal((await upload(app, as('kiosk'))).statusCode, 201, 'the kiosk token still runs visitor sessions');
  assert.equal((await upload(app, as('ops'))).statusCode, 201, 'the operator token works everywhere');
  assert.equal((await upload(app, as('wrong'))).statusCode, 401);
  await app.close();
});

test('/ready reports why the mirror cannot take visitors; /health stays up', async () => {
  const up = await mirrorApp({ openai: openaiFake(), sidecar: fakeSidecar({ bundle: () => bundleFor() }) });
  assert.deepEqual((await up.app.inject('/ready')).json(), { ready: true, problems: [] });
  await up.app.close();

  const down = await mirrorApp({ openai: openaiFake(), sidecar: fakeSidecar({ bundle: () => bundleFor(), down: true }) });
  const ready = await down.app.inject('/ready');
  assert.equal(ready.statusCode, 503);
  assert.deepEqual(ready.json().problems, ['sidecar_unavailable']);
  assert.equal((await down.app.inject('/health')).statusCode, 200);
  await down.app.close();
});

test('draining refuses new work, keeps reads working, and waits for renders in progress', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const openai = openaiFake();
  const slow = { fetchImpl: async (url, init) => (String(url).endsWith('/images/edits') && (await gate), openai.fetchImpl(url, init)) };
  const { app } = await mirrorApp({ openai: slow, sidecar: fakeSidecar({ bundle: () => bundleFor() }) });
  const id = (await upload(app)).json().sessionId;
  await waitFor(async () => (await app.inject(`/api/v2/sessions/${id}`)).json().renders?.[0]?.status === 'rendering');

  const draining = app.drain({ timeoutMs: 3000 });
  const refused = await upload(app);
  assert.equal(refused.statusCode, 503);
  assert.equal(refused.json().code, 'draining');
  assert.equal((await app.inject(`/api/v2/sessions/${id}`)).statusCode, 200);
  assert.ok((await app.inject('/ready')).json().problems.includes('draining'));
  release();
  assert.deepEqual(await draining, { drained: true });
  assert.equal((await app.inject(`/api/v2/sessions/${id}`)).json().renders[0].status, 'done', 'the render in progress finished');
  await app.close();
});

test('session routes are rate limited per visitor session, not per kiosk address', async () => {
  const { app } = await mirrorApp({ openai: openaiFake(), sidecar: fakeSidecar({ bundle: () => bundleFor() }), env: { RATE_LIMIT_MAX: '2' } });
  const next = (id) => app.inject({ method: 'POST', url: `/api/v2/sessions/${id}/next` }).then((r) => r.statusCode);
  assert.deepEqual([await next('a'), await next('a'), await next('a')], [404, 404, 429]);
  assert.equal(await next('b'), 404, 'another visitor on the same kiosk is not blocked');
  await app.close();
});

test('when images fail, the visitor gets their outfits as text, then pictures again once the service is back', async () => {
  const openai = openaiFake({ imageStatus: (n) => (n === 1 ? 500 : 200) });
  const { app } = await mirrorApp({ openai, sidecar: fakeSidecar({ bundle: () => bundleFor() }) });
  const id = (await upload(app)).json().sessionId;
  const failed = await waitForRender(app, id);
  assert.equal(failed.render.status, 'failed');
  assert.equal(failed.render.error, VISITOR_MESSAGES.imagesUnavailable, 'no internal error text on screen');
  assert.deepEqual(failed.session.degraded, { mode: 'text-only', reason: 'images_unavailable', message: VISITOR_MESSAGES.imagesUnavailable });
  assert.equal(failed.session.rounds[0].options.length, 3, 'the outfit ideas are there');

  assert.equal((await app.inject({ method: 'POST', url: `/api/v2/sessions/${id}/render`, payload: { round: 1, option: 1 } })).statusCode, 202);
  const retried = await waitFor(async () => {
    const session = (await app.inject(`/api/v2/sessions/${id}`)).json();
    return session.renders[0].status === 'done' ? session : null;
  });
  assert.equal(retried.degraded, null);
  await app.close();
});

test('a subject change never takes a finished look off screen, but drops early designs while waiting', async () => {
  const sidecar = fakeSidecar({ bundle: () => bundleFor() });
  const { app } = await mirrorApp({ openai: openaiFake(), sidecar });
  await waitFor(() => sidecar.connected());
  const startCamera = async () => (await app.inject({ method: 'POST', url: '/api/v2/sessions', payload: { style: 'office', consent: true } })).json().sessionId;

  const shown = await startCamera();
  sidecar.emit({ type: 'capture', sessionId: shown, captureId: 'cap123' });
  await waitForRender(app, shown);
  sidecar.emit({ type: 'subject', subjectId: 2, replaced: true });
  await waitFor(async () => (await app.inject('/api/v2/metrics')).json().counters.subject_replaced >= 1);
  const stillShown = await app.inject(`/api/v2/sessions/${shown}`);
  assert.equal(stillShown.statusCode, 200, 'the visitor walking up to the screen keeps their look (bug seen on 7 Nov)');
  assert.equal(stillShown.json().renders[0].status, 'done');

  const waiting = await startCamera();
  sidecar.emit({ type: 'profile', sessionId: waiting, profile: { skin: { skinUndertone: 'cool', skinDepth: 'light', confidence: 'medium' }, height: {}, frame: {} } });
  await waitFor(async () => (await app.inject('/api/v2/metrics')).json().counters.early_designs >= 1);
  sidecar.emit({ type: 'subject', subjectId: 3, replaced: true });
  await waitFor(async () => (await app.inject('/api/v2/metrics')).json().counters.subject_replaced >= 2);
  assert.equal((await app.inject(`/api/v2/sessions/${waiting}`)).json().status, 'waiting_for_capture', 'the new person can still be captured');

  sidecar.emit({ type: 'capture', sessionId: waiting, captureId: 'cap123' });
  await waitForRender(app, waiting);
  const counters = (await app.inject('/api/v2/metrics')).json().counters;
  assert.equal(counters.early_design_hits ?? 0, 0, 'the previous person\'s early outfits are never used');
  assert.equal(counters.early_design_recoloured ?? 0, 0);
  await app.close();
});

test('alerts: logged and posted once per cooldown; counted alerts need a threshold', async () => {
  const posted = [];
  let clock = 0;
  const alerts = createAlerts({
    webhookUrl: 'https://hooks.example/x',
    cooldownMs: 1000,
    now: () => clock,
    fetchImpl: async (url, init) => (posted.push(JSON.parse(init.body).text), new Response('ok')),
    log: { warn: () => {} }
  });
  await alerts.notify('camera', 'Camera error');
  await alerts.notify('camera', 'Camera error');
  clock = 1500;
  await alerts.notify('camera', 'Camera error');
  assert.deepEqual(posted, ['[KYRA mirror] Camera error', '[KYRA mirror] Camera error']);

  await alerts.count('renders', 'Renders failing', { threshold: 3 });
  await alerts.count('renders', 'Renders failing', { threshold: 3 });
  assert.equal(posted.length, 2);
  await alerts.count('renders', 'Renders failing', { threshold: 3 });
  assert.match(posted[2], /Renders failing \(3 in 10 min\)/);
});

test('log files rotate daily and old ones are deleted', () => {
  const dir = tempDir();
  writeFileSync(path.join(dir, 'kyra-2026-10-01.log'), 'old\n');
  let day = '2026-11-06';
  const stream = createLogStream({ dir, retentionDays: 14, stdout: null, today: () => day });
  stream.write('{"msg":"a"}\n');
  day = '2026-11-07';
  stream.write('{"msg":"b"}\n');
  assert.deepEqual(readdirSync(dir).sort(), ['kyra-2026-11-06.log', 'kyra-2026-11-07.log']);
});

test('metrics survive a restart', () => {
  const file = path.join(tempDir(), 'not-yet-created', 'metrics.json');
  const before = createMetrics({ file });
  before.count('sessions', 3);
  before.time('design', 1200);
  before.save();
  assert.ok(existsSync(file));
  const after = createMetrics({ file }).summary();
  assert.equal(after.counters.sessions, 3);
  assert.equal(after.steps.design.count, 1);
});

test('the sidecar is never given up on: quick retries, then every few minutes; a long run resets the count', () => {
  assert.deepEqual(restartPlan(0, 1000), { restarts: 1, delayMs: 2000 });
  assert.deepEqual(restartPlan(5, 1000), { restarts: 6, delayMs: 300_000 });
  assert.deepEqual(restartPlan(9, 10 * 60_000), { restarts: 1, delayMs: 2000 });
});

// ---- security fixes (audit of 7 Nov 2026) -------------------------------------------------------------

test('requests addressed to another host are refused (DNS rebinding)', async () => {
  assert.equal(hostName('127.0.0.1:3000'), '127.0.0.1');
  assert.equal(hostName('[::1]:3000'), '::1');
  const names = allowedHostNames({ host: '0.0.0.0', allowedHosts: ['mirror.local'], publicBaseUrl: 'https://192.168.1.20:3000' });
  assert.deepEqual([...names].sort(), ['127.0.0.1', '192.168.1.20', '::1', 'localhost', 'mirror.local']);

  const { app } = await mirrorApp({ openai: openaiFake(), sidecar: fakeSidecar({ bundle: () => bundleFor() }) });
  assert.equal((await app.inject({ url: '/api/v2/metrics', headers: { host: '127.0.0.1:3000' } })).statusCode, 200);
  const rebound = await app.inject({ url: '/api/v2/metrics', headers: { host: 'attacker.example:3000' } });
  assert.equal(rebound.statusCode, 403);
  assert.equal((await app.inject({ url: '/looks/0123', headers: { host: 'attacker.example' } })).statusCode, 403);
  await app.close();
});

test('responses carry security headers; the share page gets a strict content policy', async () => {
  const { app } = await mirrorApp({ openai: openaiFake(), sidecar: fakeSidecar({ bundle: () => bundleFor() }) });
  const api = await app.inject('/api/v2/metrics');
  assert.equal(api.headers['x-content-type-options'], 'nosniff');
  assert.equal(api.headers['referrer-policy'], 'no-referrer');
  assert.equal(api.headers['x-frame-options'], 'DENY');
  assert.equal(api.headers['cache-control'], 'no-store');
  const page = await app.inject(`/looks/${'ab'.repeat(16)}`);
  assert.match(page.headers['content-security-policy'], /default-src 'none'/);
  await app.close();
});

test('only the session\'s own stream and the operator see visitor images and links', async (t) => {
  const { app } = await mirrorApp({ openai: openaiFake(), sidecar: fakeSidecar({ bundle: () => bundleFor() }), env: { OPERATOR_TOKEN: 'ops' } });
  const anyone = await listenWithEvents(app, t);
  const base = anyone.base;
  const id = (await upload(app)).json().sessionId;
  // Closed at the end of the test, before the shared helper closes the server (which waits for streams).
  const controllers = [];
  const stream = async (query) => {
    const seen = [];
    const controller = new AbortController();
    controllers.push(controller);
    const response = await fetch(`${base}/api/v2/events${query}`, { signal: controller.signal });
    (async () => {
      let buffer = '';
      try {
        for await (const chunk of response.body) {
          buffer += new TextDecoder().decode(chunk);
          for (const block of buffer.split('\n\n').slice(0, -1)) {
            const data = block.split('\n').find((line) => line.startsWith('data:'));
            if (data) {
              seen.push(JSON.parse(data.slice(5)));
            }
          }
          buffer = buffer.slice(buffer.lastIndexOf('\n\n') + 2);
        }
      } catch {
        // aborted
      }
    })();
    await waitFor(() => seen.some((e) => e.type === 'hello'));
    return seen;
  };
  const own = await stream(`?sessionId=${id}`);
  const operator = await stream('?token=ops');
  await waitForRender(app, id);
  await app.inject({ method: 'POST', url: `/api/v2/sessions/${id}/render`, payload: { round: 1, option: 2 } });
  await waitForRender(app, id, '1.2');
  const done = (seen) => waitFor(() => seen.find((e) => e.type === 'session.render.done' && e.option === 2));
  assert.equal((await done(anyone.seen)).imageDataUrl, null);
  assert.match((await done(own)).imageDataUrl, /^data:image\//);
  assert.match((await done(operator)).imageDataUrl, /^data:image\//);
  controllers.forEach((controller) => controller.abort());
});

test('tokens are generated on first start, kept owner-only, and can be turned off on purpose', () => {
  const runtimeDir = tempDir();
  let n = 0;
  const first = ensureTokens({ runtimeDir, apiToken: '', operatorToken: '' }, { generate: () => `generated-${++n}` });
  assert.equal(first.config.apiToken, 'generated-1');
  assert.equal(first.config.operatorToken, 'generated-2');
  assert.deepEqual(first.generated, ['apiToken', 'operatorToken']);
  assert.equal(statSync(first.file).mode & 0o777, 0o600);
  const again = ensureTokens({ runtimeDir, apiToken: '', operatorToken: '' }, { generate: () => 'never' });
  assert.equal(again.config.apiToken, 'generated-1', 'the same token after a restart');
  assert.deepEqual(again.generated, []);
  const set = ensureTokens({ runtimeDir, apiToken: 'mine', operatorToken: 'off' });
  assert.equal(set.config.apiToken, 'mine');
  assert.equal(set.config.operatorToken, '');
  assert.ok(!readFileSync(first.file, 'utf8').includes('mine'), 'configured tokens are not copied to disk');
});

test('the sidecar process gets only its own settings, never the OpenAI key or the API tokens', () => {
  const env = sidecarEnv(
    { PATH: '/bin', HOME: '/h', CAMERA_INDEX: '1', SKIN_FRAMES: '15', OPENAI_API_KEY: 'sk-x', API_TOKEN: 'a', OPERATOR_TOKEN: 'o', ALERT_WEBHOOK_URL: 'https://hook', SIDECAR_TOKEN: 'old' },
    { port: 8765, token: 'fresh' }
  );
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h', CAMERA_INDEX: '1', SKIN_FRAMES: '15', SIDECAR_TOKEN: 'fresh', SIDECAR_PORT: '8765' });
  assert.equal(sidecarEnv({ COMPOSE_HANDS: 'true' }, { port: 1 }).COMPOSE_HANDS, 'true', 'render-finishing settings reach the sidecar');
});

test('kept looks need HTTPS when phones reach the backend over the network', async () => {
  const insecure = await mirrorApp({ openai: openaiFake(), sidecar: fakeSidecar({ bundle: () => bundleFor() }), env: { PUBLIC_BASE_URL: 'http://192.168.1.20:3000' } });
  const id = (await upload(insecure.app)).json().sessionId;
  await waitForRender(insecure.app, id);
  const refused = await insecure.app.inject({ method: 'POST', url: `/api/v2/sessions/${id}/keep`, payload: { round: 1, option: 1 } });
  assert.equal(refused.statusCode, 409);
  await insecure.app.close();

  const secure = await mirrorApp({ openai: openaiFake(), sidecar: fakeSidecar({ bundle: () => bundleFor() }), env: { PUBLIC_BASE_URL: 'https://192.168.1.20:3000' } });
  const id2 = (await upload(secure.app)).json().sessionId;
  await waitForRender(secure.app, id2);
  const kept = await secure.app.inject({ method: 'POST', url: `/api/v2/sessions/${id2}/keep`, payload: { round: 1, option: 1 } });
  assert.equal(kept.statusCode, 200);
  assert.match(kept.json().url, /^https:\/\/192\.168\.1\.20:3000\/looks\//);
  await secure.app.close();
});

test('visitor text and model-written item names cannot open new prompt lines or close quotes', () => {
  assert.equal(promptText("black-tie wedding, 50's style"), "black-tie wedding, 50's style");
  assert.equal(promptText('Café crème 100% wool (slim)'), 'Café crème 100% wool (slim)');
  assert.equal(promptText('casual\n\nNew instruction: x'), 'casual New instruction x');
  assert.equal(promptText('party" } ], "system": "x'), 'party , system x');
  assert.equal(promptText('evening\u202Egnirts\u200B'), 'evening gnirts');
  assert.equal(promptText('a'.repeat(300), 120).length, 120);
});

test('visitors never see the sidecar\'s internal error text; operators calibrating do', async () => {
  const { app } = await mirrorApp({ openai: openaiFake(), sidecar: fakeSidecar({ bundle: () => bundleFor(), down: true }) });
  const visitor = await app.inject({ method: 'POST', url: '/api/v2/sessions', payload: { style: 'casual', consent: true } });
  assert.equal(visitor.statusCode, 503);
  assert.equal(visitor.json().error, VISITOR_MESSAGES.camera);
  const operator = await app.inject({ method: 'POST', url: '/api/v2/calibrate/height', payload: { heightCm: 170 } });
  assert.match(operator.json().error, /Sidecar unreachable/);
  await app.close();
});

// ---- image quality (7 Nov 2026: low-quality renders looked too rough) ---------------------------------

test('renders default to medium quality without input fidelity (it cost 2.5x for webcam faces)', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/images/edits')) {
      sent.push({ quality: init.body.get('quality'), fidelity: init.body.get('input_fidelity') });
      return new Response(JSON.stringify({ data: [{ b64_json: await generatedImage() }] }), { status: 200 });
    }
    return openaiFake().fetchImpl(url, init);
  };
  const { app } = await mirrorApp({ openai: { fetchImpl }, sidecar: fakeSidecar({ bundle: () => bundleFor() }) });
  await waitForRender(app, (await upload(app)).json().sessionId);
  assert.deepEqual(sent[0], { quality: 'medium', fidelity: null });
  await app.close();
});

test('with OPENAI_INPUT_FIDELITY=high, fidelity is dropped if the model rejects it', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/images/edits')) {
      const form = init.body;
      sent.push({ quality: form.get('quality'), fidelity: form.get('input_fidelity') });
      if (form.get('input_fidelity')) {
        return new Response(JSON.stringify({ error: { message: "Unknown parameter: 'input_fidelity'." } }), { status: 400 });
      }
      return new Response(JSON.stringify({ data: [{ b64_json: await generatedImage() }] }), { status: 200 });
    }
    return openaiFake().fetchImpl(url, init);
  };
  const { app } = await mirrorApp({ openai: { fetchImpl }, sidecar: fakeSidecar({ bundle: () => bundleFor() }), env: { OPENAI_INPUT_FIDELITY: 'high' } });
  const first = (await upload(app)).json().sessionId;
  assert.equal((await waitForRender(app, first)).render.status, 'done', 'the render still succeeds');
  assert.deepEqual(sent.slice(0, 2), [{ quality: 'medium', fidelity: 'high' }, { quality: 'medium', fidelity: null }]);
  const second = (await upload(app)).json().sessionId;
  await waitForRender(app, second);
  assert.equal(sent.at(-1).fidelity, null, 'once rejected, fidelity is not sent again');
  await app.close();
});

// ---- easier setup (7 Nov 2026: teammates got stuck setting up) -----------------------------------

test('the backend serves the test consoles itself, on whatever port it runs', async () => {
  const { app } = await mirrorApp({ openai: openaiFake(), sidecar: fakeSidecar({ bundle: () => bundleFor() }) });
  assert.equal((await app.inject('/console')).headers.location, '/console/');
  const page = await app.inject('/console/');
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /location\.pathname\.startsWith\('\/console'\) \? location\.origin/);
  assert.match(page.headers['content-security-policy'], /script-src 'self' 'unsafe-inline'.*connect-src 'self'/);
  assert.equal((await app.inject('/console/dashboard.html')).statusCode, 200);
  assert.equal((await app.inject('/console/../.env')).statusCode, 404);
  assert.equal((await app.inject('/console/secrets.json')).statusCode, 404);
  await app.close();
});

// ---- the team's kiosk UI (Kyra-UI-V1), served by the backend ------------------------------------------

test('the backend serves the built kiosk UI: files, client-side routes, and nothing outside the build', async () => {
  const dist = tempDir();
  mkdirSync(path.join(dist, 'assets'), { recursive: true });
  mkdirSync(path.join(dist, 'mediapipe', 'wasm'), { recursive: true });
  writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
  writeFileSync(path.join(dist, 'assets', 'index-B2x9KfQa.js'), 'console.log(1)');
  writeFileSync(path.join(dist, 'assets', 'logo.png'), 'png');
  writeFileSync(path.join(dist, 'mediapipe', 'wasm', 'vision.wasm'), 'wasm');
  writeFileSync(path.join(dist, '.env'), 'SECRET=1');
  writeFileSync(path.join(path.dirname(dist), 'outside.txt'), 'no');
  const { app } = await mirrorApp({ openai: openaiFake(), sidecar: fakeSidecar({ bundle: () => bundleFor() }), env: { FRONTEND_DIR: dist } });

  assert.equal((await app.inject('/Kyra-UI-V1')).headers.location, '/Kyra-UI-V1/');
  const page = await app.inject('/Kyra-UI-V1/');
  assert.equal(page.statusCode, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.headers['content-security-policy'], /script-src 'self' 'wasm-unsafe-eval'/);
  assert.match(page.headers['content-security-policy'], /connect-src 'self'/);
  assert.equal(page.headers['cache-control'], 'no-cache');
  // A screen's address loads the app, which routes on the client.
  assert.match((await app.inject('/Kyra-UI-V1/welcome/looking-for-today')).body, /id="root"/);

  const script = await app.inject('/Kyra-UI-V1/assets/index-B2x9KfQa.js');
  assert.match(script.headers['content-type'], /text\/javascript/);
  assert.match(script.headers['cache-control'], /immutable/);
  assert.equal((await app.inject('/Kyra-UI-V1/mediapipe/wasm/vision.wasm')).headers['content-type'], 'application/wasm');
  assert.equal((await app.inject('/Kyra-UI-V1//assets/logo.png')).statusCode, 200, 'a doubled slash still finds the file');
  assert.equal((await app.inject('/Kyra-UI-V1/assets/missing.png')).statusCode, 404, 'a missing asset is a 404, not the app');

  for (const url of ['/Kyra-UI-V1/../outside.txt', '/Kyra-UI-V1/%2e%2e/outside.txt', '/Kyra-UI-V1/..%2Foutside.txt', '/Kyra-UI-V1/.env']) {
    const response = await app.inject(url);
    assert.ok([400, 404].includes(response.statusCode), `${url}: ${response.statusCode}`);
    assert.ok(response.body !== 'no' && !response.body.includes('SECRET'), url);
  }
  await app.close();
});

test('before the UI is built, its address says how to build it; FRONTEND_DIR="" turns it off', async () => {
  const empty = await mirrorApp({ openai: openaiFake(), sidecar: fakeSidecar({ bundle: () => bundleFor() }), env: { FRONTEND_DIR: tempDir() } });
  const response = await empty.app.inject('/Kyra-UI-V1/');
  assert.equal(response.statusCode, 404);
  assert.match(response.body, /npm ci && npm run build/);
  await empty.app.close();

  const off = await mirrorApp({ openai: openaiFake(), sidecar: fakeSidecar({ bundle: () => bundleFor() }), env: { FRONTEND_DIR: '' } });
  assert.doesNotMatch((await off.app.inject('/Kyra-UI-V1/')).body, /npm run build/);
  await off.app.close();
});

test('the kiosk can ask for the camera preview cropped to its screen, and only with valid numbers', async () => {
  const sidecar = fakeSidecar({ bundle: () => bundleFor() });
  const urls = [];
  const fetchImpl = sidecar.fetchImpl;
  sidecar.fetchImpl = (url, init) => {
    urls.push(String(url));
    return fetchImpl(url, init);
  };
  const { app } = await mirrorApp({ openai: openaiFake(), sidecar });
  const preview = () => urls.filter((u) => u.includes('/preview.mjpg')).at(-1);
  await app.inject('/api/v2/preview.mjpg?aspect=0.28125&height=1670');
  assert.match(preview(), /\/preview\.mjpg\?aspect=0\.2813&height=1670$/);
  await app.inject('/api/v2/preview.mjpg?aspect=0.28125&height=99999');
  assert.match(preview(), /height=2160$/, 'height is capped');
  await app.inject('/api/v2/preview.mjpg?aspect=abc&extra=1');
  assert.match(preview(), /\/preview\.mjpg$/, 'nonsense falls back to the plain preview; nothing else is forwarded');
  await app.inject('/api/v2/preview.mjpg');
  assert.match(preview(), /\/preview\.mjpg$/);
  await app.close();
});

test('the camera orientation check is for staff only and passes the sidecar\'s answer through', async () => {
  const sidecar = fakeSidecar({ bundle: () => bundleFor() });
  const fetchImpl = sidecar.fetchImpl;
  sidecar.fetchImpl = async (url, init) =>
    new URL(url).pathname === '/camera/orientation'
      ? new Response(JSON.stringify({ found: true, current: 0, suggested: 270, correct: false }), { headers: { 'content-type': 'application/json' } })
      : fetchImpl(url, init);
  const { app } = await mirrorApp({ openai: openaiFake(), sidecar, env: { API_TOKEN: 'kiosk-token', OPERATOR_TOKEN: 'staff-token' } });
  const ask = (token) => app.inject({ url: '/api/v2/calibration/orientation', headers: { authorization: `Bearer ${token}` } });
  assert.equal((await ask('kiosk-token')).statusCode, 401, 'the kiosk token cannot use it');
  const staff = await ask('staff-token');
  assert.equal(staff.statusCode, 200);
  assert.equal(staff.json().suggested, 270);
  await app.close();
});

test('perception events tell the UI how long to hold still, for its 3-2-1 countdown', async (t) => {
  const sidecar = fakeSidecar({ bundle: () => bundleFor() });
  const { app } = await mirrorApp({ openai: openaiFake(), sidecar });
  const { seen } = await listenWithEvents(app, t);
  await waitFor(() => sidecar.connected());
  sidecar.emit({ type: 'state', state: 'ready', message: 'Perfect — hold that pose', ready: true, heldMs: 1200, holdMs: 3000, armed: true });
  const event = await waitFor(() => seen.find((e) => e.type === 'perception' && e.state === 'ready'));
  assert.equal(event.holdMs, 3000);
  assert.equal(event.heldMs, 1200);
});

test('the .env.example placeholder key counts as no key, so /ready says so', async () => {
  const { app } = await mirrorApp({ openai: openaiFake(), sidecar: fakeSidecar({ bundle: () => bundleFor() }), env: { OPENAI_API_KEY: 'your_openai_api_key_here' } });
  assert.ok((await app.inject('/ready')).json().problems.includes('openai_not_configured'));
  await app.close();
});

test('a setting given on the command line wins over backend/.env; .env fills in the rest', async () => {
  const { loadLocalEnv } = await import('../src/config.js');
  const file = path.join(tempDir(), '.env');
  writeFileSync(file, 'KYRA_TEST_PORT=3000\nKYRA_TEST_ONLY_IN_FILE=from-file\n');
  process.env.KYRA_TEST_PORT = '3100';
  loadLocalEnv(file);
  assert.equal(process.env.KYRA_TEST_PORT, '3100');
  assert.equal(process.env.KYRA_TEST_ONLY_IN_FILE, 'from-file');
  delete process.env.KYRA_TEST_PORT;
  delete process.env.KYRA_TEST_ONLY_IN_FILE;
});

// ---- clearest face + token savings (7 Nov 2026) ------------------------------------------------------

test('lean defaults: no image previews, no look rendered unasked, no early design, no colour names to write', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/images/edits')) {
      calls.push({ kind: 'image', stream: init.body.get('stream'), partials: init.body.get('partial_images') });
      return new Response(JSON.stringify({ data: [{ b64_json: await generatedImage() }] }), { status: 200 });
    }
    const body = JSON.parse(init.body);
    calls.push({ kind: 'text', schema: body.text?.format?.schema });
    return openaiFake().fetchImpl(url, init);
  };
  const { loadConfig } = await import('../src/config.js');
  const defaults = loadConfig({});
  assert.equal(defaults.partialImages, 0);
  assert.equal(defaults.prefetchOptions, 'false');
  assert.equal(defaults.earlyDesign, false);
  assert.equal(defaults.renderFaceReference, false);
  assert.equal(defaults.renderRetries, 0);

  const { app } = await mirrorApp({ openai: { fetchImpl }, sidecar: fakeSidecar({ bundle: () => bundleFor() }), env: { PARTIAL_IMAGES: '0', PREFETCH_OPTIONS: 'false' } });
  const id = (await upload(app)).json().sessionId;
  await waitForRender(app, id);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(calls.filter((c) => c.kind === 'image').length, 1, 'only the look the visitor sees is rendered');
  assert.equal(calls.find((c) => c.kind === 'image').partials, null, 'no streamed previews');
  const itemSchema = calls.find((c) => c.kind === 'text').schema.properties.options.items.properties.items.items;
  assert.ok(!('colorName' in itemSchema.properties) && !itemSchema.required.includes('colorName'));
  await app.close();
});

test('a clearer face seen after the photo is put onto the finished look, for free', async (t) => {
  const sidecar = fakeSidecar({ bundle: () => bundleFor() });
  const { app } = await mirrorApp({ openai: openaiFake(), sidecar });
  const { base, seen } = await listenWithEvents(app, t);
  await waitFor(() => sidecar.connected());
  const created = await fetch(`${base}/api/v2/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ style: 'office', consent: true }) });
  const { sessionId } = await created.json();
  sidecar.emit({ type: 'capture', sessionId, captureId: 'cap123' });
  await waitForRender(app, sessionId);
  const imagesBefore = sidecar.callsTo('/compose').length;

  sidecar.emit({ type: 'face', better: true, score: 0.9 });
  const upgraded = await waitFor(() => seen.find((e) => e.type === 'session.render.done' && e.upgraded));
  assert.equal(upgraded.faceCheck.headDecision, 'clearest face from the visit (updated)');
  const session = (await app.inject(`/api/v2/sessions/${sessionId}`)).json();
  assert.equal(session.renders[0].imageDataUrl, 'data:image/png;base64,Q0xFQVJGQUNF');
  assert.equal(sidecar.callsTo('/compose').length, imagesBefore, 'no new render or compose: just the face');
});

// ---- "Still here?" (13 Nov 2026) -------------------------------------------------------------------------
// The camera reports the visitor gone after ABSENT_AFTER_MS; the visit then waits LEAVE_GRACE_MS for them.

async function capturedVisit(app, t, sidecar) {
  const { base, seen } = await listenWithEvents(app, t);
  await waitFor(() => sidecar.connected());
  const { sessionId } = await (await fetch(`${base}/api/v2/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ style: 'office', consent: true }) })).json();
  sidecar.emit({ type: 'capture', sessionId, captureId: 'cap123' });
  await waitFor(() => seen.find((e) => e.type === 'session.profile'));
  return { base, seen, sessionId };
}

test('visitor out of view: the kiosk gets a countdown, then the visit ends', async (t) => {
  const sidecar = fakeSidecar({ bundle: () => bundleFor() });
  const { app } = await mirrorApp({ openai: openaiFake(), sidecar, env: { LEAVE_GRACE_MS: '400' } });
  const { base, seen, sessionId } = await capturedVisit(app, t, sidecar);
  const before = Date.now();
  sidecar.emit({ type: 'presence', present: false });
  const leaving = await waitFor(() => seen.find((e) => e.type === 'session.leaving'));
  assert.equal(leaving.sessionId, sessionId);
  assert.ok(leaving.endsAt >= before + 350 && leaving.endsAt <= Date.now() + 400, 'endsAt: now + LEAVE_GRACE_MS');
  const during = await fetch(`${base}/api/v2/sessions/${sessionId}`);
  assert.equal(during.status, 200, 'still there during the grace');
  assert.equal((await during.json()).leavingEndsAt, leaving.endsAt, 'a reconnecting kiosk can show the countdown');
  assert.ok(!seen.some((e) => e.type === 'session.ended'));
  const ended = await waitFor(() => seen.find((e) => e.type === 'session.ended'), { timeoutMs: 3000 });
  assert.equal(ended.reason, 'visitor_left');
  assert.ok(Date.now() - before >= 380, 'not before the grace ran out');
  assert.equal((await fetch(`${base}/api/v2/sessions/${sessionId}`)).status, 404, 'forgotten');
});

test('back in view during the grace: the visit carries on', async (t) => {
  const sidecar = fakeSidecar({ bundle: () => bundleFor() });
  const { app } = await mirrorApp({ openai: openaiFake(), sidecar, env: { LEAVE_GRACE_MS: '300' } });
  const { base, seen, sessionId } = await capturedVisit(app, t, sidecar);
  sidecar.emit({ type: 'presence', present: false });
  await waitFor(() => seen.find((e) => e.type === 'session.leaving'));
  sidecar.emit({ type: 'presence', present: true });
  const stayed = await waitFor(() => seen.find((e) => e.type === 'session.stayed'));
  assert.equal(stayed.reason, 'present');
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok(!seen.some((e) => e.type === 'session.ended'), 'the timer was cancelled');
  const after = await (await fetch(`${base}/api/v2/sessions/${sessionId}`)).json();
  assert.equal(after.leavingEndsAt, null);
});

test('"Still here" pressed during the grace keeps the visit; LEAVE_GRACE_MS=0 ends at once', async (t) => {
  const sidecar = fakeSidecar({ bundle: () => bundleFor() });
  const { app } = await mirrorApp({ openai: openaiFake(), sidecar, env: { LEAVE_GRACE_MS: '300' } });
  const { base, seen, sessionId } = await capturedVisit(app, t, sidecar);
  const stillHere = (id) => fetch(`${base}/api/v2/sessions/${id}/still-here`, { method: 'POST' });
  assert.deepEqual(await (await stillHere(sessionId)).json(), { stayed: false, leavingEndsAt: null }, 'nothing to cancel yet');
  sidecar.emit({ type: 'presence', present: false });
  await waitFor(() => seen.find((e) => e.type === 'session.leaving'));
  sidecar.emit({ type: 'presence', present: true }); // back in view, then Still here: nothing more to do
  await waitFor(() => seen.find((e) => e.type === 'session.stayed'));
  sidecar.emit({ type: 'presence', present: false });
  await waitFor(() => seen.filter((e) => e.type === 'session.leaving').length === 2);
  sidecar.emit({ type: 'presence', present: true });
  await waitFor(() => seen.filter((e) => e.type === 'session.stayed').length === 2);
  const inView = await (await stillHere(sessionId)).json();
  assert.deepEqual(inView, { stayed: false, leavingEndsAt: null }, 'in view: no countdown');
  sidecar.emit({ type: 'presence', present: false });
  await waitFor(() => seen.filter((e) => e.type === 'session.leaving').length === 3);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const pressed = await (await stillHere(sessionId)).json();
  assert.equal(pressed.stayed, true);
  assert.equal((await waitFor(() => seen.filter((e) => e.type === 'session.stayed')[2])).reason, 'visitor');
  assert.ok(!seen.some((e) => e.type === 'session.ended'));
  assert.equal((await stillHere('no-such-visit')).status, 404);

  const quick = fakeSidecar({ bundle: () => bundleFor() });
  const { app: app2 } = await mirrorApp({ openai: openaiFake(), sidecar: quick, env: { LEAVE_GRACE_MS: '0' } });
  const second = await capturedVisit(app2, t, quick);
  quick.emit({ type: 'presence', present: false });
  assert.equal((await waitFor(() => second.seen.find((e) => e.type === 'session.ended'))).reason, 'visitor_left');
  assert.ok(!second.seen.some((e) => e.type === 'session.leaving'), 'no grace: no countdown');
});

test('"Still here" while the camera still sees nobody: a fresh countdown, so the visit still ends', async (t) => {
  const sidecar = fakeSidecar({ bundle: () => bundleFor() });
  const { app } = await mirrorApp({ openai: openaiFake(), sidecar, env: { LEAVE_GRACE_MS: '400' } });
  const { base, seen, sessionId } = await capturedVisit(app, t, sidecar);
  sidecar.emit({ type: 'presence', present: false });
  const first = await waitFor(() => seen.find((e) => e.type === 'session.leaving'));
  await new Promise((resolve) => setTimeout(resolve, 250));
  const answer = await (await fetch(`${base}/api/v2/sessions/${sessionId}/still-here`, { method: 'POST' })).json();
  assert.equal(answer.stayed, true);
  assert.ok(answer.leavingEndsAt > first.endsAt, 'a fresh countdown from the press');
  const again = await waitFor(() => seen.filter((e) => e.type === 'session.leaving')[1]);
  assert.equal(again.endsAt, answer.leavingEndsAt);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.ok(!seen.some((e) => e.type === 'session.ended'), 'the first countdown no longer ends it');
  const ended = await waitFor(() => seen.find((e) => e.type === 'session.ended'), { timeoutMs: 3000 });
  assert.equal(ended.reason, 'visitor_left', 'nobody came back: it ends after the fresh grace');
});

// ---- "Your results" (13 Nov 2026) ------------------------------------------------------------------------

test('your results: a private page of the visit, a photo only of a look taken home', async (t) => {
  const sidecar = fakeSidecar({ bundle: () => bundleFor() });
  const { app } = await mirrorApp({ openai: openaiFake(), sidecar, env: { KEEP_HOURS: '24' } });
  const { base, seen, sessionId } = await capturedVisit(app, t, sidecar);
  const post = () => fetch(`${base}/api/v2/sessions/${sessionId}/results`, { method: 'POST' });
  const first = await (await post()).json();
  assert.match(first.url, /\/results\/[0-9a-f]{32}$/);
  assert.match(first.qrDataUrl, /^data:image\/png;base64,/);
  const expires = Date.parse(first.expiresAt) - Date.now();
  assert.ok(expires > 23.9 * 3600_000 && expires <= 24 * 3600_000, 'KEEP_HOURS');
  const page = await fetch(first.url.replace(/^https?:\/\/[^/]+/, base));
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Warm undertone, medium depth/);
  assert.match(html, /class="palette"/);
  assert.doesNotMatch(html, /<img/, 'no picture: nothing was taken home');
  assert.equal((await (await post()).json()).url, first.url, 'asked again: the same page');

  await waitFor(() => seen.find((e) => e.type === 'session.render.done'));
  const kept = await (await fetch(`${base}/api/v2/sessions/${sessionId}/keep`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ round: 1, option: 1 }) })).json();
  const keptToken = kept.url.split('/').pop();
  const second = await (await post()).json();
  assert.notEqual(second.url, first.url, 'a look was taken home: a new page');
  const withLook = await (await fetch(second.url.replace(/^https?:\/\/[^/]+/, base))).text();
  assert.match(withLook, new RegExp(`<img src="/looks/${keptToken}\\.png"`), 'only the kept look');
  assert.equal((withLook.match(/<img/g) || []).length, 1);
  assert.equal((await fetch(`${base}/results/${'ab'.repeat(16)}`)).status, 404);
  assert.equal((await fetch(`${base}/results/not-a-token`)).status, 404);
});

test('your results: not before the profile, and never when keeping is off or would be plain HTTP', async (t) => {
  const sidecar = fakeSidecar({ bundle: () => bundleFor() });
  const { app } = await mirrorApp({ openai: openaiFake(), sidecar, env: { KEEP_HOURS: '0' } });
  const { base, sessionId } = await capturedVisit(app, t, sidecar);
  const off = await fetch(`${base}/api/v2/sessions/${sessionId}/results`, { method: 'POST' });
  assert.equal(off.status, 409);
  assert.equal((await off.json()).code, 'keeping_disabled');

  const insecureSidecar = fakeSidecar({ bundle: () => bundleFor() });
  const { app: insecure } = await mirrorApp({ openai: openaiFake(), sidecar: insecureSidecar, env: { KEEP_HOURS: '24', PUBLIC_BASE_URL: 'http://192.168.1.20:3000', ALLOWED_HOSTS: '127.0.0.1' } });
  const second = await capturedVisit(insecure, t, insecureSidecar);
  assert.equal((await fetch(`${second.base}/api/v2/sessions/${second.sessionId}/results`, { method: 'POST' })).status, 409, 'plain HTTP on a network: refused, like kept looks');

  const early = fakeSidecar({ bundle: () => bundleFor() });
  const { app: app3 } = await mirrorApp({ openai: openaiFake(), sidecar: early, env: { KEEP_HOURS: '24' } });
  const { base: base3 } = await listenWithEvents(app3, t);
  await waitFor(() => early.connected());
  const { sessionId: waiting } = await (await fetch(`${base3}/api/v2/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ style: 'office', consent: true }) })).json();
  const notYet = await fetch(`${base3}/api/v2/sessions/${waiting}/results`, { method: 'POST' });
  assert.equal(notYet.status, 409, 'no photo yet: no results');
});
