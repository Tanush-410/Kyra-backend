// Kyra Tags end to end, across real processes: this backend listening on a port, and the Raspberry Pi
// program (nfc/raspberry_pi/main.py) talking to it over HTTP with its device token. The PN532 and the tag
// are simulated (NFC_MOCK=true: mock_pn532.py places a blank NTAG213 on the "reader" 2 s in), so this proves
// the software path, not real hardware. Skipped when python3 isn't installed.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers.js';
import { bundleFor, fakeSidecar, generatedImage, mirrorApp, waitFor, waitForRender } from './mirror-helpers.js';

const PI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../nfc/raspberry_pi');
const PYTHON = process.env.PYTHON || 'python3';
const hasPython = spawnSync(PYTHON, ['--version']).status === 0;
const DEVICE = 'e2e-device-token';
const DESIGN = { options: [1, 2, 3].map((n) => ({ title: `Look ${n}`, summary: 'x', reasoning: 'y', items: [{ category: 'top', name: 'Tee', colorName: 'Cream', hex: '#EFE3C6', fit: 'regular', material: 'cotton' }] })) };
const openai = {
  fetchImpl: async (url) =>
    String(url).includes('/images/')
      ? new Response(JSON.stringify({ data: [{ b64_json: await generatedImage() }] }), { status: 200 })
      : new Response(JSON.stringify({ output_text: JSON.stringify(DESIGN) }), { status: 200 })
};

test('a finished visit to a programmed Kyra Tag: kiosk, backend, the Pi program and a phone opening the link', { skip: !hasPython && 'python3 not installed', timeout: 60_000 }, async (t) => {
  const { app } = await mirrorApp({
    openai,
    sidecar: fakeSidecar({ bundle: () => bundleFor() }),
    env: { RUNTIME_DIR: tempDir(), NFC_TAGS: 'true', NFC_DEVICE_TOKEN: DEVICE, NFC_PUBLIC_BASE_URL: 'https://kyra.style', API_TOKEN: 'kiosk' }
  });
  t.after(() => app.close());
  const base = await app.listen({ port: 0, host: '127.0.0.1' });
  const kiosk = { authorization: 'Bearer kiosk', 'content-type': 'application/json' };
  const call = async (method, url, body) => {
    const response = await fetch(`${base}${url}`, { method, headers: kiosk, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  // A visit that reached its looks.
  const created = await call('POST', '/api/v2/sessions', { style: 'casual', consent: true, imageDataUrl: `data:image/png;base64,${await generatedImage()}` });
  const sessionId = created.body.sessionId;
  await waitForRender(app, sessionId).catch(() => null);
  await waitFor(async () => (await call('GET', `/api/v2/sessions/${sessionId}`)).body.profile);

  // The tag writer starts: the real main.py, simulated PN532.
  const log = [];
  const pi = spawn(PYTHON, ['main.py'], {
    cwd: PI_DIR,
    env: { ...process.env, NFC_MOCK: 'true', KYRA_BACKEND_URL: base, NFC_DEVICE_TOKEN: DEVICE, NFC_DEVICE_ID: 'pi-e2e', NFC_POLL_SECONDS: '0.3', NFC_TAG_WAIT_SECONDS: '20', PYTHONUNBUFFERED: '1' }
  });
  pi.stdout.on('data', (chunk) => log.push(String(chunk)));
  pi.stderr.on('data', (chunk) => log.push(String(chunk)));
  t.after(() => pi.kill('SIGINT'));

  // The kiosk offers the tag only once the writer is online (it polls the backend).
  await waitFor(async () => (await call('GET', '/api/v2/nfc/status')).body.deviceOnline, { timeoutMs: 15_000, intervalMs: 200 });

  // YES: the kiosk asks for a tag, then follows the job as the screen does.
  const issued = await call('POST', `/api/v2/sessions/${sessionId}/nfc/issue`, {});
  assert.equal(issued.status, 202);
  const seen = [issued.body.status];
  const final = await waitFor(
    async () => {
      const { body } = await call('GET', `/api/v2/nfc/jobs/${issued.body.jobId}`);
      if (seen.at(-1) !== body.status) seen.push(body.status);
      return ['succeeded', 'failed', 'cancelled'].includes(body.status) && body;
    },
    { timeoutMs: 30_000, intervalMs: 50 }
  ).catch((error) => {
    throw new Error(`${error.message}\nPi log:\n${log.join('')}`);
  });
  assert.equal(final.status, 'succeeded', `the job: ${JSON.stringify(final)}\nPi log:\n${log.join('')}`);
  assert.ok(seen.includes('waiting_for_tag') || seen.includes('writing') || seen.includes('verifying'), `steps seen: ${seen}`);
  assert.match(log.join(''), /tag programmed and verified/, 'the Pi read the tag back before reporting success');

  // A phone tapping the tag opens its URL: the visit's Canvas.
  const token = final.url.split('/s/')[1];
  const page = await fetch(`${base}/s/${token}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<html/i);

  // Reading mode: the same tag left on the Pi's reader is recognised as a live Kyra link.
  await waitFor(async () => /Kyra Tag read/.test(log.join('')), { timeoutMs: 10_000, intervalMs: 100 });
});
