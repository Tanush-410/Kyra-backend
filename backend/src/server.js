import { buildApp } from './app.js';
import { loadConfig, loadLocalEnv } from './config.js';
import { ensureTokens } from './lib/secrets.js';

loadLocalEnv();
// Tokens are on by default: empty API_TOKEN / OPERATOR_TOKEN are generated once and kept in RUNTIME_DIR.
const { config, generated, file: tokenFile } = ensureTokens(loadConfig());
const app = await buildApp(config);

if (generated.length) {
  // The tokens themselves are never logged: read them from the file (owner-only).
  app.log.warn({ file: tokenFile, generated }, 'Generated access tokens. Give the kiosk "apiToken" and operators "operatorToken" from this file');
}
if (!config.apiToken) {
  const exposed = !['127.0.0.1', 'localhost', '::1'].includes(config.host);
  app.log.warn(exposed ? 'API_TOKEN=off on a network address: anyone on this network can use the mirror and spend the OpenAI key.' : 'API_TOKEN=off: any program on this machine can use the API.');
}
if (config.apiToken && !config.operatorToken) {
  app.log.warn('OPERATOR_TOKEN=off: the kiosk token can also recalibrate the camera and read metrics.');
}

// Never hang on the way out: a stuck close still exits, so the supervisor can start a fresh process.
function exitAfter(ms, code) {
  setTimeout(() => process.exit(code), ms).unref();
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) {
    app.log.warn({ signal }, 'Second signal: exiting now');
    process.exit(1);
  }
  shuttingDown = true;
  app.log.info({ signal, graceMs: config.shutdownGraceMs }, 'Shutting down: finishing renders in progress');
  exitAfter(config.shutdownGraceMs + 10_000, 1);
  const { drained } = await app.drain();
  if (!drained) {
    app.log.warn('Renders still running at the end of the grace period; they are abandoned');
  }
  await app.close();
  process.exit(0);
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(signal));
}

// A stray rejected promise (a background prefetch, a dropped connection) is logged, not fatal: one
// visitor's failure must not end everyone's session.
process.on('unhandledRejection', (reason) => {
  app.log.error({ err: reason }, 'Unhandled promise rejection');
  app.alerts.count('unhandled_rejection', 'Unhandled errors in the backend', { threshold: 5 });
});

// After an uncaught exception the process state is unknown: report it, close what we can, and exit
// so the supervisor (launchd, pm2, systemd) restarts a clean process.
process.on('uncaughtException', async (error) => {
  app.log.fatal({ err: error }, 'Uncaught exception; restarting');
  exitAfter(5_000, 1);
  await app.alerts.notify('crash', `Backend crashed: ${error.message}`).catch(() => {});
  await app.close().catch(() => {});
  process.exit(1);
});

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
