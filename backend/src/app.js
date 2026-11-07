import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimitPlugin from '@fastify/rate-limit';
import { createAlerts } from './lib/alerts.js';
import { createBudget } from './lib/budget.js';
import { createCatalogue } from './lib/catalogue.js';
import { createEventHub } from './lib/events.js';
import { createInsights } from './lib/insights.js';
import { createJobStore } from './lib/jobs.js';
import { createLogStream, requestSerializer } from './lib/logfile.js';
import { createLookStore } from './lib/looks.js';
import { createMetrics } from './lib/metrics.js';
import { createMirror } from './lib/mirror.js';
import { createOpenAI } from './lib/openai.js';
import { createLimiter } from './lib/queue.js';
import { createSessionStore } from './lib/sessions.js';
import { createSidecar, maybeSpawnSidecar } from './lib/sidecar.js';
import { createStorage } from './lib/storage.js';
import { backendRoot } from './config.js';
import { createUsageLog, DEFAULT_PRICES } from './lib/usage.js';
import handheldRoutes from './routes/handheld.js';
import jobRoutes from './routes/jobs.js';
import mirrorRoutes from './routes/mirror.js';
import reviewRoutes from './routes/review.js';
import styleMeRoutes from './routes/style-me.js';
import suggestionRoutes from './routes/suggestion.js';

const MEMORY_SWEEP_INTERVAL_MS = 60_000;
const DISK_SWEEP_INTERVAL_MS = 10 * 60_000;
// Routes only the operator may call when OPERATOR_TOKEN is set: calibration (and its reset) and metrics.
const OPERATOR_ROUTE = /^\/api\/v2\/(calibrat|metrics)/;
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1'];
const ANY_ADDRESS = ['0.0.0.0', '::', ''];
// Sent with every response. The share page gets a strict content policy: its own image, inline styles.
const SECURITY_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' };
const HTML_POLICY = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
// The consoles are single files with inline script, talking only to this backend.
const CONSOLE_POLICY = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'";

// "127.0.0.1:3000" -> "127.0.0.1", "[::1]:3000" -> "::1".
export function hostName(header) {
  const host = String(header || '').trim().toLowerCase();
  if (host.startsWith('[')) {
    return host.slice(1, host.indexOf(']') > 0 ? host.indexOf(']') : undefined);
  }
  return host.split(':').length === 2 ? host.split(':')[0] : host;
}

// Host names this backend answers to: localhost, a specific HOST address, PUBLIC_BASE_URL's host, ALLOWED_HOSTS.
export function allowedHostNames(config) {
  const names = new Set([...LOOPBACK_HOSTS, ...config.allowedHosts]);
  if (!ANY_ADDRESS.includes(config.host)) {
    names.add(hostName(config.host));
  }
  if (config.publicBaseUrl) {
    try {
      names.add(hostName(new URL(config.publicBaseUrl).host));
    } catch {
      // an invalid PUBLIC_BASE_URL adds nothing
    }
  }
  return names;
}

// Logger settings: secrets are kept out of request logs; in production lines also go to daily log files.
function loggerOptions(logger, config) {
  if (!logger) {
    return false;
  }
  const base = typeof logger === 'object' ? logger : {};
  const stream = logger === true && config.logDir ? createLogStream({ dir: config.logDir, retentionDays: config.logRetentionDays }) : undefined;
  return { ...base, serializers: { req: requestSerializer, ...(base.serializers || {}) }, ...(stream ? { stream } : {}) };
}

export async function buildApp(config, { logger = true, fetchImpl, sidecarFetch, alertFetch, spawnSidecar = true } = {}) {
  const https = config.tls ? { cert: readFileSync(config.tls.certFile), key: readFileSync(config.tls.keyFile) } : null;
  const app = Fastify({ logger: loggerOptions(logger, config), bodyLimit: 10 * 1024 * 1024, ...(https ? { https } : {}) });
  const alerts = createAlerts({ webhookUrl: config.alertWebhookUrl, cooldownMs: config.alertCooldownMs, name: config.alertName, fetchImpl: alertFetch, log: app.log });

  const storage = createStorage({ artifactsDir: config.artifactsDir, retentionHours: config.retentionHours });
  const jobs = createJobStore({ storage, timeoutMs: config.tryOnJobTimeoutMs, ttlMs: config.jobTtlMs });
  const sessions = createSessionStore({ ttlMs: config.sessionTtlMs });
  const catalogue = createCatalogue(config);
  const events = createEventHub();
  const budget = createBudget({
    file: config.runtimeDir ? path.join(config.runtimeDir, 'budget.json') : null,
    dailyUsd: config.dailyBudgetUsd,
    costs: config.costs,
    warnFraction: config.budgetWarnFraction,
    onWarn: (summary) => {
      alerts.notify('budget', `Daily OpenAI spend passed ${Math.round(config.budgetWarnFraction * 100)}% of the cap`, { budget: summary });
      events.publish({ type: 'budget.warning', ...summary });
    }
  });
  const insights = createInsights({ dir: config.runtimeDir });
  const usageLog = createUsageLog({ prices: config.prices || DEFAULT_PRICES });
  const openai = createOpenAI({
    apiKey: config.openaiApiKey,
    model: config.openaiModel,
    imageModel: config.openaiImageModel,
    timeoutMs: config.openaiTimeoutMs,
    maxRetries: config.openaiMaxRetries,
    inputFidelity: config.openaiInputFidelity,
    baseUrl: config.openaiBaseUrl,
    reasoningEffort: config.openaiReasoningEffort,
    fetchImpl,
    budget,
    usageLog,
    log: app.log
  });

  const sidecar = createSidecar({ url: config.sidecarUrl, token: config.sidecarToken, fetchImpl: sidecarFetch, log: app.log });
  const metrics = createMetrics({ file: config.runtimeDir ? path.join(config.runtimeDir, 'metrics.json') : null });
  metrics.count('process_starts');
  const limiter = createLimiter(config.renderConcurrency);
  const lookBaseUrl = config.publicBaseUrl || `${https ? 'https' : 'http'}://${ANY_ADDRESS.includes(config.host) ? 'localhost' : config.host}:${config.port}`;
  const lookUrl = new URL(lookBaseUrl);
  // A kept look is a photo of a visitor: over plain HTTP on a network, anyone nearby could read it and its link.
  const insecureLooks = lookUrl.protocol !== 'https:' && !LOOPBACK_HOSTS.includes(hostName(lookUrl.host)) && !config.allowInsecureLooks;
  if (insecureLooks) {
    app.log.warn({ publicBaseUrl: lookBaseUrl }, 'Keeping looks is disabled: phones would load visitors\' photos over plain HTTP. Set up TLS (TLS_CERT_FILE/TLS_KEY_FILE) and an https PUBLIC_BASE_URL');
  }
  const looks = createLookStore({
    dir: path.join(config.artifactsDir, 'kept'),
    keepHours: insecureLooks ? 0 : config.keepHours,
    publicBaseUrl: lookBaseUrl
  });
  const mirror = createMirror({ config, openai, sidecar, events, metrics, limiter, looks, budget, insights, alerts, log: app.log });

  // Session routes are limited per visitor session, everything else per client address. A kiosk sends
  // every visitor's requests from one address, so a per-address limit would make visitors share it.
  const rateLimitKey = (request) => (request.params?.sessionId ? `session:${request.params.sessionId}` : request.ip);
  await app.register(cors, { origin: config.corsOrigins });
  await app.register(rateLimitPlugin, { global: false, keyGenerator: rateLimitKey });

  let draining = false;
  const allowedHosts = allowedHostNames(config);
  app.decorateRequest('isOperator', false);
  app.addHook('onRequest', async (request, reply) => {
    // DNS rebinding: a web page can point its own domain at this machine, but cannot change the Host header.
    if (!allowedHosts.has(hostName(request.headers.host))) {
      return reply.code(403).send({ error: 'Host not allowed.' });
    }
    if (!request.url.startsWith('/api/') || request.method === 'OPTIONS') {
      return;
    }
    const token = providedToken(request);
    const isOperator = Boolean(config.operatorToken) && sameToken(token, config.operatorToken);
    request.isOperator = isOperator;
    if (config.operatorToken && OPERATOR_ROUTE.test(request.url)) {
      if (!isOperator) {
        return reply.code(401).send({ error: 'This needs the operator token.' });
      }
    } else if (config.apiToken && !isOperator && !sameToken(token, config.apiToken)) {
      return reply.code(401).send({ error: 'Missing or invalid API token.' });
    }
    if (draining && request.method === 'POST') {
      return reply.code(503).header('retry-after', '30').send({ error: 'The mirror is restarting. Please try again in a moment.', code: 'draining' });
    }
    if (request.method === 'POST' && !openai.isConfigured && !request.url.startsWith('/api/v2/calibrate')) {
      return reply.code(500).send({ error: 'OPENAI_API_KEY is not set: put your key in backend/.env and restart.', code: 'openai_not_configured' });
    }
  });

  app.addHook('onSend', async (request, reply, payload) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      reply.header(name, value);
    }
    if (!reply.hasHeader('cache-control')) {
      reply.header('cache-control', 'no-store'); // responses carry visitors' photos and measurements
    }
    if (String(reply.getHeader('content-type') || '').startsWith('text/html') && !reply.hasHeader('content-security-policy')) {
      reply.header('content-security-policy', HTML_POLICY);
    }
    return payload;
  });

  // The test consoles (backend/dev), served by the backend itself: no second web server, and they talk to
  // this backend whatever PORT it runs on. Open http://localhost:<PORT>/console/ (npm run links adds the token).
  const consoleFiles = { '': 'mirror.html', 'mirror.html': 'mirror.html', 'dashboard.html': 'dashboard.html', 'style-me.html': 'style-me.html' };
  const serveConsole = async (request, reply) => {
    const file = consoleFiles[request.params.file || ''];
    if (!file) {
      return reply.code(404).type('text/plain').send('Not found. Try /console/, /console/dashboard.html or /console/style-me.html');
    }
    return reply
      .type('text/html; charset=utf-8')
      .header('content-security-policy', CONSOLE_POLICY)
      .send(readFileSync(path.join(backendRoot, 'dev', file)));
  };
  app.get('/console', async (request, reply) => reply.redirect('/console/'));
  app.get('/console/', serveConsole);
  app.get('/console/:file', serveConsole);

  app.get('/health', async () => {
    const sidecarHealth = await sidecar.health().catch(() => null);
    return {
      message: 'KYRA backend is running via Fastify',
      openaiConfigured: openai.isConfigured,
      sidecar: sidecarHealth ? { camera: sidecarHealth.camera, cameraError: sidecarHealth.cameraError || '' } : 'unavailable',
      persistence: storage.enabled ? `on, ${config.retentionHours}h retention` : 'off',
      budget: budget.summary(),
      activeJobs: jobs.size(),
      activeSessions: sessions.size() + mirror.size()
    };
  });

  // Ready for visitors: OpenAI configured, sidecar reachable with its camera running, budget left.
  // /health always answers 200 (the process is alive); monitors and kiosks should watch /ready.
  app.get('/ready', async (request, reply) => {
    const sidecarHealth = await sidecar.health().catch(() => null);
    const problems = [];
    if (!openai.isConfigured) {
      problems.push('openai_not_configured');
    }
    if (!sidecarHealth) {
      problems.push('sidecar_unavailable');
    } else if (!['running', 'disabled'].includes(sidecarHealth.camera)) {
      problems.push(`camera_${sidecarHealth.camera || 'unknown'}`);
    }
    if (budget.fractionUsed() >= 1) {
      problems.push('daily_budget_spent');
    }
    if (draining) {
      problems.push('draining');
    }
    return reply.code(problems.length ? 503 : 200).send({ ready: !problems.length, problems });
  });

  const rateLimit = config.rateLimitMax > 0 ? { max: config.rateLimitMax, timeWindow: config.rateLimitWindowMs, keyGenerator: rateLimitKey } : false;
  const deps = { config, openai, storage, jobs, sessions, catalogue, rateLimit, mirror, sidecar, events, metrics, budget, limiter, looks, insights, usageLog };
  await app.register(reviewRoutes, deps);
  await app.register(suggestionRoutes, deps);
  await app.register(handheldRoutes, deps);
  await app.register(styleMeRoutes, deps);
  await app.register(jobRoutes, deps);
  await app.register(mirrorRoutes, deps);

  const sweepDisk = () => {
    const deleted = storage.sweepExpired() + looks.sweep();
    if (deleted) {
      app.log.info({ deleted }, 'Deleted artifacts past retention');
    }
  };
  const memoryTimer = setInterval(() => {
    jobs.sweep();
    sessions.sweep();
    mirror.sweep();
    metrics.save();
  }, MEMORY_SWEEP_INTERVAL_MS);
  const diskTimer = setInterval(sweepDisk, DISK_SWEEP_INTERVAL_MS);
  memoryTimer.unref();
  diskTimer.unref();

  // Watchdog: a sidecar whose camera was streaming but has gone silent is restarted (if we spawned it).
  let sidecarProcess = { spawned: false, stop: () => {}, restart: () => {} };
  let lastHeartbeat = 0;
  const watchdogTimer = setInterval(() => {
    if (sidecarProcess.spawned && lastHeartbeat && Date.now() - lastHeartbeat > config.sidecarWatchdogMs) {
      alerts.notify('sidecar_silent', 'The camera sidecar went silent and is being restarted', { silentMs: Date.now() - lastHeartbeat });
      metrics.count('sidecar_restarts');
      lastHeartbeat = 0;
      sidecarProcess.restart();
    }
  }, 5000);
  watchdogTimer.unref();

  app.addHook('onReady', async () => {
    sweepDisk();
    if (spawnSidecar) {
      const port = Number(new URL(config.sidecarUrl).port) || 8765;
      sidecarProcess = await maybeSpawnSidecar({
        mode: config.sidecarSpawn,
        sidecarDir: config.sidecarDir,
        client: sidecar,
        port,
        log: app.log,
        // A sidecar we start always gets a token, generated per run unless SIDECAR_TOKEN is set.
        token: config.sidecarToken || randomBytes(24).toString('base64url'),
        onExit: ({ code, signal, restarts, retryInMs }) => {
          metrics.count('sidecar_crashes');
          alerts.notify('sidecar_exit', `The camera sidecar exited (code ${code ?? signal}); restart ${restarts} in ${Math.round(retryInMs / 1000)} s`);
        }
      });
    }
    sidecar.subscribe(
      (event) => {
        // Only live camera states count: a sidecar without a camera never sends them, so is never restarted.
        if (event.type === 'state') {
          lastHeartbeat = Date.now();
        }
        if (event.type === 'camera' && ['error', 'reconnecting'].includes(event.status)) {
          alerts.notify(`camera_${event.status}`, `Camera ${event.status}: ${event.error || 'no detail'}`);
        }
        mirror.onSidecarEvent(event);
      },
      (status) => {
        app.log.info({ status }, 'Sidecar event stream');
        events.publish({ type: 'sidecar', status });
      }
    );
  });
  // Graceful shutdown: refuse new work, then wait (up to timeoutMs) for paid renders already running.
  app.decorate('drain', async ({ timeoutMs = config.shutdownGraceMs } = {}) => {
    draining = true;
    const deadline = Date.now() + timeoutMs;
    const busy = () => {
      const { running, waiting } = limiter.stats();
      return running + waiting > 0;
    };
    while (busy() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return { drained: !busy() };
  });
  app.decorate('alerts', alerts);

  app.addHook('onClose', async () => {
    metrics.save();
    clearInterval(memoryTimer);
    clearInterval(diskTimer);
    clearInterval(watchdogTimer);
    jobs.close();
    sidecar.close();
    events.close();
    sidecarProcess.stop();
  });

  return app;
}

function providedToken(request) {
  const header = String(request.headers.authorization || '');
  const provided = header.startsWith('Bearer ') ? header.slice(7) : String(request.headers['x-api-key'] || '');
  // EventSource and <img> cannot send headers, so GET requests may pass ?token= (redacted from logs).
  return provided || (request.method === 'GET' ? String(request.query?.token || '') : '');
}

function sameToken(provided, expected) {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
}
