import { Readable } from 'node:stream';
import { MirrorError, VISITOR_MESSAGES } from '../lib/mirror.js';
import { normalizeGender, normalizeHeight, normalizePreferences, normalizeString, pickEnum, promptText } from '../lib/normalize.js';
import { SidecarError } from '../lib/sidecar.js';
import { resultsPage } from '../lib/results-page.js';

// v2: the camera-first mirror pipeline. The UI opens GET /api/v2/events once and reacts to events;
// these endpoints only start things.
const UNDERTONES = ['warm', 'cool', 'neutral'];
const DEPTHS = ['fair', 'light', 'medium', 'tan', 'deep'];
const BUILDS = ['slim', 'medium', 'broad'];

export default async function mirrorRoutes(app, { config, mirror, sidecar, events, metrics, budget, limiter, looks, insights, usageLog, rateLimit }) {
  const fail = (reply, error) => {
    if (error instanceof MirrorError) {
      return reply.code(error.status).send({ error: error.message, ...(error.code ? { code: error.code } : {}) });
    }
    if (error instanceof SidecarError) {
      // Operators calibrating need the sidecar's reason ("card too dark"); visitors get a plain message.
      reply.request.log.warn({ error: error.message, status: error.status }, 'Sidecar request failed');
      const message = reply.request.isOperator || reply.request.url.startsWith('/api/v2/calibrat') ? error.message : VISITOR_MESSAGES.camera;
      return reply.code(error.status >= 400 && error.status < 500 ? error.status : 503).send({ error: message, code: 'sidecar' });
    }
    throw error;
  };
  const optionRef = (body) => ({ round: Number(body?.round) || 1, option: Number(body?.option) || 1 });

  app.get('/api/v2/events', async (request, reply) => {
    const sidecarHealth = await sidecar.health().catch((error) => ({ ok: false, error: error.message }));
    events.attach(reply, {
      sessionId: normalizeString(request.query?.sessionId) || null,
      privileged: request.isOperator || config.eventStreamImages === 'all',
      initial: [{ type: 'hello', sidecar: sidecarHealth.ok ? sidecarHealth.camera : 'unavailable', at: Date.now() }]
    });
  });

  app.post('/api/v2/sessions', { config: { rateLimit } }, async (request, reply) => {
    const body = request.body || {};
    const style = promptText(body.style, 120);
    const gender = normalizeGender(body.gender);
    if (!style) {
      return reply.code(400).send({ error: 'style is required (for example "formal", "wedding guest", "casual").' });
    }
    if (body.gender !== undefined && body.gender !== '' && !gender) {
      return reply.code(400).send({ error: 'gender must be "male" or "female" when provided.' });
    }
    if (body.imageDataUrl !== undefined && typeof body.imageDataUrl !== 'string') {
      return reply.code(400).send({ error: 'imageDataUrl must be a data URL string.' });
    }
    // Photos go to OpenAI, so the visitor has to agree before the camera captures them.
    if (config.requireConsent && body.consent !== true) {
      return reply.code(400).send({ error: 'The visitor must consent before their photo is taken.', code: 'consent_required' });
    }
    try {
      return reply.code(201).send(
        await mirror.start({
          style,
          gender,
          heightCm: normalizeHeight(body.heightCm),
          preferences: normalizePreferences(body.preferences),
          imageDataUrl: body.imageDataUrl || null,
          consent: body.consent === true
        })
      );
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/v2/sessions/:sessionId', async (request, reply) => {
    try {
      return mirror.get(request.params.sessionId);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/v2/sessions/:sessionId/redesign', { config: { rateLimit } }, async (request, reply) => {
    const body = request.body || {};
    try {
      return await mirror.redesign(request.params.sessionId, {
        style: promptText(body.style, 120),
        feedback: promptText(body.feedback, 200),
        preferences: body.preferences !== undefined ? normalizePreferences(body.preferences, { partial: true }) : null
      });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/v2/sessions/:sessionId/render', { config: { rateLimit } }, async (request, reply) => {
    const { round, option } = optionRef(request.body);
    try {
      return reply.code(202).send(mirror.render(request.params.sessionId, round, option));
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/v2/sessions/:sessionId/profile', { config: { rateLimit } }, async (request, reply) => {
    const body = request.body || {};
    const corrections = {
      skinUndertone: pickEnum(body.skinUndertone, UNDERTONES),
      skinDepth: pickEnum(body.skinDepth, DEPTHS),
      heightCm: normalizeHeight(body.heightCm),
      build: pickEnum(body.build, BUILDS)
    };
    if (!Object.values(corrections).some(Boolean)) {
      return reply.code(400).send({ error: 'Send at least one of skinUndertone, skinDepth, heightCm, build.' });
    }
    try {
      return await mirror.correctProfile(request.params.sessionId, corrections);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/v2/sessions/:sessionId/profile/confirm', async (request, reply) => {
    try {
      return mirror.confirmProfile(request.params.sessionId);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/v2/sessions/:sessionId/next', { config: { rateLimit } }, async (request, reply) => {
    try {
      return reply.code(202).send(mirror.showNext(request.params.sessionId));
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/v2/sessions/:sessionId/rate', async (request, reply) => {
    const rating = pickEnum(request.body?.rating, ['up', 'down']);
    if (!rating) {
      return reply.code(400).send({ error: 'rating must be "up" or "down".' });
    }
    try {
      return mirror.rate(request.params.sessionId, { ...optionRef(request.body), rating });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/v2/sessions/:sessionId/keep', async (request, reply) => {
    try {
      return await mirror.keep(request.params.sessionId, optionRef(request.body));
    } catch (error) {
      if (!(error instanceof MirrorError) && /disabled/.test(error.message)) {
        return reply.code(409).send({ error: error.message });
      }
      return fail(reply, error);
    }
  });

  // "Your results" (the profile screen): a temporary page of this visit's results, and its QR code.
  app.post('/api/v2/sessions/:sessionId/results', async (request, reply) => {
    try {
      return await mirror.results(request.params.sessionId);
    } catch (error) {
      if (!(error instanceof MirrorError) && /disabled/.test(error.message)) {
        return reply.code(409).send({ error: 'Results can’t be taken home on this mirror.', code: 'keeping_disabled' });
      }
      return fail(reply, error);
    }
  });

  // "Still here?": the visitor pressed Still here while the visit was about to end (session.leaving).
  app.post('/api/v2/sessions/:sessionId/still-here', async (request, reply) => {
    try {
      return mirror.stillHere(request.params.sessionId);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.delete('/api/v2/sessions/:sessionId', async (request, reply) => {
    try {
      mirror.end(request.params.sessionId);
      return { ended: true };
    } catch (error) {
      return fail(reply, error);
    }
  });

  // ?aspect=width/height&height=px: a screen that shows only part of the camera's view (the portrait kiosk)
  // gets that part at full resolution instead of a stretched piece of the small preview.
  app.get('/api/v2/preview.mjpg', async (request, reply) => {
    const aspect = Number(request.query?.aspect);
    const height = Math.round(Number(request.query?.height));
    const crop = Number.isFinite(aspect) && aspect >= 0.1 && aspect <= 10
      ? { aspect: Math.round(aspect * 10000) / 10000, height: Number.isFinite(height) && height > 0 ? Math.min(2160, Math.max(120, height)) : null }
      : null;
    const upstream = await sidecar.preview(crop).catch(() => null);
    if (!upstream?.ok || !upstream.body) {
      return reply.code(503).send({ error: 'Camera preview unavailable.' });
    }
    const stream = Readable.fromWeb(upstream.body);
    request.raw.on('close', () => stream.destroy());
    return reply.header('content-type', upstream.headers.get('content-type')).header('cache-control', 'no-cache').send(stream);
  });

  app.get('/api/v2/calibration', async (request, reply) => sidecar.calibration().catch((error) => fail(reply, error)));
  // Operator only (under /calibration): npm run camera-check.
  app.get('/api/v2/calibration/orientation', async (request, reply) => sidecar.orientation().catch((error) => fail(reply, error)));
  app.delete('/api/v2/calibration', async (request, reply) => sidecar.resetCalibration().catch((error) => fail(reply, error)));
  app.post('/api/v2/calibrate/height', async (request, reply) =>
    sidecar.calibrateHeight({ heightCm: Number(request.body?.heightCm) }).catch((error) => fail(reply, error))
  );
  app.post('/api/v2/calibrate/white-balance', async (request, reply) =>
    sidecar.calibrateWhiteBalance({ roi: request.body?.roi }).catch((error) => fail(reply, error))
  );
  // Fits the undertone detector's warm/cool anchors from visitors' corrections and confirmations.
  // { save: false } (the default) only reports held-out accuracy; { save: true } applies the fit.
  app.post('/api/v2/calibrate/undertone', async (request, reply) =>
    sidecar
      .calibrateUndertone({ samples: insights.undertoneSamples(), save: request.body?.save === true })
      .catch((error) => fail(reply, error))
  );

  app.get('/api/v2/metrics', async () => ({
    budget: budget.summary(),
    queue: limiter.stats(),
    activeSessions: mirror.size(),
    eventClients: events.size(),
    insights: insights.summary(),
    usage: usageLog.summary(),
    ...metrics.summary()
  }));

  // "Your results", public like a kept look: the unguessable token is the access control.
  app.get('/results/:token', async (request, reply) => {
    const results = looks.getResults(request.params.token);
    if (!results) {
      return reply.code(404).type('text/html').send('<!doctype html><meta charset="utf-8"><title>KYRA</title><p>These results have expired.</p>');
    }
    return reply.type('text/html; charset=utf-8').header('cache-control', 'private, no-store').send(resultsPage(results));
  });

  // Public by design: the unguessable token is the access control, so phones can open the QR link.
  app.get('/looks/:token', async (request, reply) => {
    const token = String(request.params.token).replace(/\.png$/, '');
    const look = looks.get(token);
    if (!look) {
      return reply.code(404).type('text/html').send('<!doctype html><meta charset="utf-8"><title>KYRA</title><p>This look has expired.</p>');
    }
    if (request.params.token.endsWith('.png')) {
      return reply.type('image/png').header('cache-control', 'private, max-age=3600').send(look.image);
    }
    return reply.type('text/html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Your KYRA look</title>
<style>body{margin:0;background:#000;color:#eee;font:15px/1.5 system-ui,sans-serif;text-align:center}
img{display:block;width:100%;max-width:640px;margin:0 auto}a{color:#fff}p{padding:12px 16px}</style></head>
<body><img src="/looks/${token}.png" alt="Your look from the KYRA mirror">
<p><a href="/looks/${token}.png" download="kyra-look.png">Download</a> · available until ${new Date(look.expiresAt).toLocaleString('en-GB')}</p></body></html>`);
  });
}
