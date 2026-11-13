// KYRA NFC TAGS (3 of 3): the HTTP side. See nfc/README.md for the whole system and the Raspberry Pi.
//
// Kiosk (kiosk token, like every /api route):
//   GET  /api/v2/nfc/status                      { enabled, deviceOnline }: offer a tag only when a writer is up
//   POST /api/v2/sessions/:sessionId/link        the visit's short URL { url, token, expiresAt }
//   POST /api/v2/sessions/:sessionId/nfc/issue   start programming a tag with that URL -> { jobId, status, url }
//   GET  /api/v2/nfc/jobs/:jobId                 the job's status (also sent as 'session.nfc' events)
//   POST /api/v2/nfc/jobs/:jobId/cancel
// Tag writer (Raspberry Pi; the device token NFC_DEVICE_TOKEN, never given to the kiosk):
//   GET  /api/v2/nfc/device/next?deviceId=       the next job { jobId, url } or 204
//   POST /api/v2/nfc/device/jobs/:jobId/status   { status, tagUid?, error? }: waiting_for_tag, writing, verifying, succeeded, failed
//   GET  /api/v2/nfc/device/links/:token         is a scanned tag's link one of ours, and live? (reading mode)
// Staff (operator token): DELETE /api/v2/nfc/links/:token   revoke a link (a lost tag)
// Public: GET /s/:token   the Canvas (the visit's results page), or a plain page saying it's gone.
import { timingSafeEqual } from 'node:crypto';
import { MirrorError } from '../lib/mirror.js';
import { createTagJobs, publicJob } from '../lib/nfc-jobs.js';
import { createLinkStore, isLinkToken } from '../lib/nfc-links.js';
import { resultsPage } from '../lib/results-page.js';
import path from 'node:path';
import QRCode from 'qrcode';

const sameToken = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
};
const bearer = (request) => {
  const header = String(request.headers.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7) : '';
};
const gonePage = (title, text) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · KYRA</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:#3a3a3a;font:16px/1.5 -apple-system,system-ui,sans-serif}
main{max-width:420px;padding:28px 24px;border-radius:6px;background:linear-gradient(160deg,#f6f1ea,#efe7de);color:#3b3532;text-align:center}
h1{font-family:Georgia,'Times New Roman',serif;font-weight:400;font-size:26px;margin:0 0 8px}p{margin:0;color:#7d7268}</style></head>
<body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;

export default async function nfcRoutes(app, { config, mirror, looks, events }) {
  const nfc = config.nfc;
  const base = (nfc.publicBaseUrl || `http://localhost:${config.port}`).replace(/\/+$/, '');
  const links = createLinkStore({ dir: path.join(config.runtimeDir || config.artifactsDir, 'nfc', 'links'), tokenLength: nfc.tokenLength });
  const jobs = createTagJobs({
    dir: path.join(config.runtimeDir || config.artifactsDir, 'nfc'),
    timeoutMs: nfc.jobTimeoutMs,
    onChange: (job) => events.publish({ type: 'session.nfc', sessionId: job.sessionId, ...publicJob(job) })
  });
  const isDevice = (request) => Boolean(nfc.deviceToken) && sameToken(bearer(request), nfc.deviceToken);
  app.decorate('nfcLinks', links);

  // The visit's short link, made from its results page (kept NFC_KEEP_HOURS when it's for a tag).
  async function linkFor(sessionId, { forTag = false } = {}) {
    const results = await mirror.results(sessionId);
    let expiresAt = results.expiresAt;
    if (forTag && nfc.keepHours > 0) {
      const until = Date.now() + nfc.keepHours * 3_600_000;
      const kept = looks.extendResults(results.token, until);
      if (kept) expiresAt = kept.expiresAt;
    }
    const link = links.forSession({ sessionId, resultsToken: results.token, expiresAt });
    if (Date.parse(expiresAt) > Date.parse(link.expiresAt)) links.extend(link.token, expiresAt);
    return { token: link.token, url: `${base}/s/${link.token}`, expiresAt };
  }
  const failWith = (reply, error) => {
    if (error instanceof MirrorError) return reply.code(error.status).send({ error: error.message, ...(error.code ? { code: error.code } : {}) });
    if (/disabled/i.test(error.message)) return reply.code(409).send({ error: 'Results can’t be kept on this mirror (KEEP_HOURS=0).', code: 'keeping_disabled' });
    throw error;
  };

  app.get('/api/v2/nfc/status', async () => ({ enabled: nfc.enabled, deviceOnline: nfc.enabled && jobs.deviceOnline() }));

  app.post('/api/v2/sessions/:sessionId/link', async (request, reply) => {
    try {
      // NO to a Kyra Tag: the same short link, as a QR code to open the Canvas on a phone.
      const link = await linkFor(request.params.sessionId);
      return { ...link, qrDataUrl: await QRCode.toDataURL(link.url, { margin: 1, width: 320 }) };
    } catch (error) {
      return failWith(reply, error);
    }
  });

  app.post('/api/v2/sessions/:sessionId/nfc/issue', async (request, reply) => {
    if (!nfc.enabled) return reply.code(409).send({ error: 'Kyra Tags aren’t available on this mirror.', code: 'nfc_disabled' });
    let link;
    try {
      link = await linkFor(request.params.sessionId, { forTag: true });
    } catch (error) {
      return failWith(reply, error);
    }
    const job = jobs.create({ sessionId: request.params.sessionId, linkToken: link.token, url: link.url });
    return reply.code(202).send({ ...publicJob(job), deviceOnline: jobs.deviceOnline() });
  });

  app.get('/api/v2/nfc/jobs/:jobId', async (request, reply) => {
    const job = jobs.get(request.params.jobId);
    return job ? publicJob(job) : reply.code(404).send({ error: 'No such tag job.' });
  });

  app.post('/api/v2/nfc/jobs/:jobId/cancel', async (request, reply) => {
    const job = jobs.cancel(request.params.jobId);
    return job ? publicJob(job) : reply.code(404).send({ error: 'No such tag job.' });
  });

  // ---- the tag writer (device token) ----
  app.get('/api/v2/nfc/device/next', async (request, reply) => {
    if (!isDevice(request)) return reply.code(401).send({ error: 'Device token required.' });
    const deviceId = String(request.query?.deviceId || '').slice(0, 40) || 'device';
    const job = jobs.claim(deviceId);
    return job ? { jobId: job.id, url: job.requestedUrl, status: job.status } : reply.code(204).send();
  });

  app.post('/api/v2/nfc/device/jobs/:jobId/status', async (request, reply) => {
    if (!isDevice(request)) return reply.code(401).send({ error: 'Device token required.' });
    const body = request.body || {};
    const deviceId = String(body.deviceId || '').slice(0, 40) || 'device';
    const result = jobs.report(request.params.jobId, deviceId, { status: String(body.status || ''), error: body.error, tagUid: body.tagUid });
    if (result.error) return reply.code(result.error === 'unknown_job' ? 404 : 409).send({ error: result.error });
    return publicJob(result.job);
  });

  app.get('/api/v2/nfc/device/links/:token', async (request, reply) => {
    if (!isDevice(request)) return reply.code(401).send({ error: 'Device token required.' });
    const { status } = links.resolve(String(request.params.token || ''));
    return { status, url: status === 'ok' ? `${base}/s/${request.params.token}` : null };
  });

  // ---- staff ----
  app.delete('/api/v2/nfc/links/:token', async (request, reply) => {
    if (!request.isOperator) return reply.code(401).send({ error: 'This needs the operator token.' });
    return links.revoke(String(request.params.token || '')) ? { revoked: true } : reply.code(404).send({ error: 'No such link.' });
  });

  // ---- public: the Canvas behind a tag or a short URL ----
  app.get('/s/:token', async (request, reply) => {
    const token = String(request.params.token || '');
    const html = (code, page) => reply.code(code).type('text/html; charset=utf-8').header('cache-control', 'private, no-store').send(page);
    if (!isLinkToken(token)) return html(404, gonePage('Not found', 'This Kyra link isn’t valid. Please check the address.'));
    const { status, link } = links.resolve(token);
    if (status === 'unknown') return html(404, gonePage('Not found', 'This Kyra link isn’t valid. Please check the address.'));
    if (status === 'revoked') return html(410, gonePage('No longer available', 'This Kyra Canvas was removed.'));
    const results = status === 'ok' ? looks.getResults(link.resultsToken) : null;
    if (!results) return html(410, gonePage('This Canvas has expired', 'Kyra Canvases are kept for a limited time. Visit the mirror again for a new one.'));
    // Kept looks expire sooner than a tag's Canvas: list only the pictures that are still there.
    return html(200, resultsPage({ ...results, looks: (results.looks || []).filter((l) => looks.hasLook(l.token)) }));
  });
}
