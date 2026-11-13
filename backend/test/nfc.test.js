// Kyra Tags: short session links and tag-programming jobs (lib/nfc-links.js, lib/nfc-jobs.js, routes/nfc.js).
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { isLinkToken, LINK_ALPHABET, newLinkToken } from '../src/lib/nfc-links.js';
import { tempDir } from './helpers.js';
import { bundleFor, fakeSidecar, generatedImage, mirrorApp, waitFor, waitForRender } from './mirror-helpers.js';

const DESIGN = { options: [1, 2, 3].map((n) => ({ title: `Look ${n}`, summary: 'x', reasoning: 'y', items: [{ category: 'top', name: 'Tee', colorName: 'Cream', hex: '#EFE3C6', fit: 'regular', material: 'cotton' }] })) };
const openai = {
  fetchImpl: async (url) =>
    String(url).includes('/images/')
      ? new Response(JSON.stringify({ data: [{ b64_json: await generatedImage() }] }), { status: 200 })
      : new Response(JSON.stringify({ output_text: JSON.stringify(DESIGN) }), { status: 200 })
};
const DEVICE = 'pi-device-secret-token';

async function finishedVisit(env = {}) {
  const runtime = tempDir();
  const { app, config } = await mirrorApp({
    openai,
    sidecar: fakeSidecar({ bundle: () => bundleFor() }),
    env: { RUNTIME_DIR: runtime, NFC_TAGS: 'true', NFC_DEVICE_TOKEN: DEVICE, NFC_PUBLIC_BASE_URL: 'https://kyra.style', API_TOKEN: 'kiosk', OPERATOR_TOKEN: 'staff', ...env }
  });
  const kiosk = { authorization: 'Bearer kiosk' };
  const device = { authorization: `Bearer ${DEVICE}` };
  const created = await app.inject({ method: 'POST', url: '/api/v2/sessions', headers: kiosk, payload: { style: 'casual', consent: true, imageDataUrl: `data:image/png;base64,${await generatedImage()}` } });
  const sessionId = created.json().sessionId;
  await waitForRender(app, sessionId).catch(() => null);
  await waitFor(async () => (await app.inject({ url: `/api/v2/sessions/${sessionId}`, headers: kiosk })).json().profile);
  return { app, config, runtime, sessionId, kiosk, device };
}

test('link tokens: random, unique, the configured length, no look-alike characters', () => {
  const tokens = new Set(Array.from({ length: 20000 }, () => newLinkToken(10)));
  assert.equal(tokens.size, 20000, 'no repeats in 20,000');
  for (const token of [...tokens].slice(0, 200)) {
    assert.equal(token.length, 10);
    assert.ok(isLinkToken(token));
    assert.doesNotMatch(token, /[0O1lI]/);
  }
  assert.equal(newLinkToken(4).length, 8, 'never shorter than 8');
  assert.equal(newLinkToken(99).length, 32);
  // Every character of the alphabet turns up: no byte range is skipped (no bias towards a few characters).
  const counts = new Map();
  for (const t of tokens) for (const c of t) counts.set(c, (counts.get(c) || 0) + 1);
  assert.equal(counts.size, LINK_ALPHABET.length);
  assert.ok(!isLinkToken('../etc/passwd') && !isLinkToken('short') && !isLinkToken('has space here'));
});

test('a finished visit gets one short link that opens its Canvas; bad, expired and revoked links say so', async () => {
  const { app, runtime, sessionId, kiosk } = await finishedVisit();
  const first = (await app.inject({ method: 'POST', url: `/api/v2/sessions/${sessionId}/link`, headers: kiosk })).json();
  assert.match(first.url, /^https:\/\/kyra\.style\/s\/[A-Za-z2-9]{10}$/);
  assert.ok(first.url.length <= 40, 'short: 31 bytes on the tag as an NDEF URI record; the smallest NTAG213 holds 144');
  const again = (await app.inject({ method: 'POST', url: `/api/v2/sessions/${sessionId}/link`, headers: kiosk })).json();
  assert.equal(again.token, first.token, 'one link per visit');
  assert.match(first.qrDataUrl, /^data:image\/png;base64,/, 'a QR code of the link, for a visitor who says no to a tag');

  const canvas = await app.inject(`/s/${first.token}`);
  assert.equal(canvas.statusCode, 200);
  assert.match(canvas.body, /Your colouring/);
  assert.match(canvas.headers['cache-control'], /no-store/);

  assert.equal((await app.inject('/s/AAAAAAAAAA')).statusCode, 404, 'unknown');
  assert.equal((await app.inject('/s/..%2F..%2Fsecrets')).statusCode, 404, 'not a token');

  // Expired: the link's date has passed.
  const file = path.join(runtime, 'nfc', 'links', `${first.token}.json`);
  const link = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...link, expiresAt: new Date(Date.now() - 1000).toISOString() }));
  const expired = await app.inject(`/s/${first.token}`);
  assert.equal(expired.statusCode, 410);
  assert.match(expired.body, /expired/);
  writeFileSync(file, JSON.stringify(link));

  // Revoked by staff (a lost tag); the kiosk token can't.
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/v2/nfc/links/${first.token}`, headers: kiosk })).statusCode, 401);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/v2/nfc/links/${first.token}`, headers: { authorization: 'Bearer staff' } })).statusCode, 200);
  assert.equal((await app.inject(`/s/${first.token}`)).statusCode, 410);
  await app.close();
});

test('issuing a tag: the writer claims the job, reports each step, and success needs the read-back', async () => {
  const { app, runtime, sessionId, kiosk, device } = await finishedVisit();
  assert.deepEqual((await app.inject({ url: '/api/v2/nfc/status', headers: kiosk })).json(), { enabled: true, deviceOnline: false });

  const issued = await app.inject({ method: 'POST', url: `/api/v2/sessions/${sessionId}/nfc/issue`, headers: kiosk });
  assert.equal(issued.statusCode, 202);
  const { jobId, status, url } = issued.json();
  assert.equal(status, 'queued');
  assert.equal((await app.inject({ method: 'POST', url: `/api/v2/sessions/${sessionId}/nfc/issue`, headers: kiosk })).json().jobId, jobId, 'one job per visit at a time');

  // The device API needs the device token: not the kiosk's, not none.
  assert.equal((await app.inject({ url: '/api/v2/nfc/device/next?deviceId=pi1', headers: kiosk })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/v2/nfc/device/next?deviceId=pi1' })).statusCode, 401);
  const claimed = (await app.inject({ url: '/api/v2/nfc/device/next?deviceId=pi1', headers: device })).json();
  assert.deepEqual(claimed, { jobId, url, status: 'waiting_for_tag' });
  assert.equal((await app.inject({ url: '/api/v2/nfc/status', headers: kiosk })).json().deviceOnline, true);
  assert.equal((await app.inject({ url: '/api/v2/nfc/device/next?deviceId=pi1', headers: device })).json().jobId, jobId, 'a restarted device gets its job back');
  assert.equal((await app.inject({ url: '/api/v2/nfc/device/next?deviceId=pi2', headers: device })).statusCode, 204, 'another device gets nothing');

  const report = (s, extra = {}, id = 'pi1') => app.inject({ method: 'POST', url: `/api/v2/nfc/device/jobs/${jobId}/status`, headers: device, payload: { deviceId: id, status: s, ...extra } });
  assert.equal((await report('succeeded')).statusCode, 409, 'success without writing and verifying is refused');
  assert.equal((await report('writing', {}, 'pi2')).statusCode, 409, 'only the device that claimed it');
  assert.equal((await report('writing')).json().status, 'writing');
  assert.equal((await report('writing')).statusCode, 200, 'a repeated report (network retry) is fine');
  assert.equal((await report('verifying')).json().status, 'verifying');
  assert.equal((await report('succeeded', { tagUid: '04A2B3C4D5E6F7' })).json().status, 'succeeded');

  const final = (await app.inject({ url: `/api/v2/nfc/jobs/${jobId}`, headers: kiosk })).json();
  assert.equal(final.status, 'succeeded');
  assert.equal(final.deviceId, undefined, 'the kiosk sees no device details');
  const tags = readFileSync(path.join(runtime, 'nfc', 'tags.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(tags.length, 1);
  assert.equal(tags[0].tagUid, '04A2B3C4D5E6F7');

  // The tagged visit's Canvas is kept longer than the usual 24 hours.
  const linkFile = readdirSync(path.join(runtime, 'nfc', 'links'))[0];
  const kept = JSON.parse(readFileSync(path.join(runtime, 'nfc', 'links', linkFile), 'utf8'));
  assert.ok(Date.parse(kept.expiresAt) - Date.now() > 20 * 86_400_000, 'about 30 days');
  // The phone opens the URL on the tag: the right Canvas.
  assert.equal((await app.inject(new URL(url).pathname)).statusCode, 200);
  // Reading mode: the Pi can check a scanned tag's link.
  assert.equal((await app.inject({ url: `/api/v2/nfc/device/links/${kept.token}`, headers: device })).json().status, 'ok');
  assert.equal((await app.inject({ url: '/api/v2/nfc/device/links/AAAAAAAAAA', headers: device })).json().status, 'unknown');
  await app.close();
});

test('a failed write, a cancel and a timeout end the job; a new tag can be asked for', async () => {
  const { app, sessionId, kiosk, device } = await finishedVisit({ NFC_JOB_TIMEOUT_S: '30' });
  const issue = async () => (await app.inject({ method: 'POST', url: `/api/v2/sessions/${sessionId}/nfc/issue`, headers: kiosk })).json();
  const first = await issue();
  await app.inject({ url: '/api/v2/nfc/device/next?deviceId=pi1', headers: device });
  const failed = await app.inject({ method: 'POST', url: `/api/v2/nfc/device/jobs/${first.jobId}/status`, headers: device, payload: { deviceId: 'pi1', status: 'failed', error: 'verify_mismatch' } });
  assert.deepEqual([failed.json().status, failed.json().error], ['failed', 'verify_mismatch']);

  const second = await issue();
  assert.notEqual(second.jobId, first.jobId, 'try again: a new job');
  assert.equal((await app.inject({ method: 'POST', url: `/api/v2/nfc/jobs/${second.jobId}/cancel`, headers: kiosk })).json().status, 'cancelled');
  assert.equal((await app.inject({ url: '/api/v2/nfc/device/next?deviceId=pi1', headers: device })).statusCode, 204, 'a cancelled job is not handed out');
  await app.close();

  const disabled = await finishedVisit({ NFC_TAGS: 'false' });
  assert.equal((await disabled.app.inject({ method: 'POST', url: `/api/v2/sessions/${disabled.sessionId}/nfc/issue`, headers: disabled.kiosk })).statusCode, 409);
  assert.deepEqual((await disabled.app.inject({ url: '/api/v2/nfc/status', headers: disabled.kiosk })).json(), { enabled: false, deviceOnline: false });
  await disabled.app.close();
});

test('jobs time out when no tag is written in time', async () => {
  const { createTagJobs } = await import('../src/lib/nfc-jobs.js');
  const jobs = createTagJobs({ dir: tempDir(), timeoutMs: 1 });
  const job = jobs.create({ sessionId: 's', linkToken: 't', url: 'https://kyra.style/s/t' });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual([jobs.get(job.id).status, jobs.get(job.id).error], ['failed', 'timed_out']);
  assert.ok(existsSync);
});
