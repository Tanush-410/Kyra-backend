import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const projectRoot = path.resolve(backendRoot, '..');

export function loadLocalEnv(envPath = path.join(backendRoot, '.env')) {
  if (!existsSync(envPath)) {
    return;
  }

  const lines = readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim().replace(/^["']|["']$/g, '');

    // A setting given on the command line (PORT=3100 npm start) wins over .env, as with every dotenv tool;
    // .env fills in everything else. (Until 7 Nov 2026 .env won, which silently ignored one-off overrides.)
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

const DEFAULT_CORS_ORIGINS = [
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost'
];

function numberFrom(value, fallback) {
  const numeric = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(numeric) ? numeric : fallback;
}

function booleanFrom(value, fallback) {
  if (value === undefined || value === '') {
    return fallback;
  }
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function corsOriginsFrom(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return DEFAULT_CORS_ORIGINS;
  }
  if (raw === '*') {
    return '*';
  }
  return raw.split(',').map((origin) => origin.trim()).filter(Boolean);
}

export function loadConfig(env = process.env) {
  return {
    host: env.HOST || '127.0.0.1',
    port: numberFrom(env.PORT, 3000),
    apiToken: env.API_TOKEN || '',
    // Calibration, calibration reset and metrics need this token when set (API_TOKEN is not enough).
    // Both tokens are generated on first start when empty (src/lib/secrets.js); "off" disables one.
    operatorToken: env.OPERATOR_TOKEN || '',
    // Host names requests may be addressed to, besides localhost, HOST and PUBLIC_BASE_URL's host.
    // Anything else is refused, which stops DNS rebinding.
    allowedHosts: String(env.ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
    // Kept looks are photos of visitors: on the venue network they need HTTPS unless this is set.
    allowInsecureLooks: booleanFrom(env.ALLOW_INSECURE_LOOKS, false),
    // session = the unfiltered event stream carries no images (clients pass ?sessionId= to get theirs);
    // all = every client gets every visitor's images (only for a frontend that cannot pass sessionId yet).
    eventStreamImages: env.EVENT_STREAM_IMAGES === 'all' ? 'all' : 'session',
    corsOrigins: corsOriginsFrom(env.CORS_ORIGINS),
    rateLimitMax: numberFrom(env.RATE_LIMIT_MAX, 10),
    rateLimitWindowMs: numberFrom(env.RATE_LIMIT_WINDOW_MS, 60_000),

    // The .env.example placeholder counts as no key, so /ready says so instead of the first render failing.
    openaiApiKey: /^(your_|sk-\.\.\.|changeme)/i.test(env.OPENAI_API_KEY || '') ? '' : env.OPENAI_API_KEY || '',
    openaiModel: env.OPENAI_MODEL || 'gpt-5.2',
    openaiImageModel: env.OPENAI_IMAGE_MODEL || 'gpt-image-1.5',
    openaiTimeoutMs: numberFrom(env.OPENAI_TIMEOUT_MS, 120_000),
    openaiMaxRetries: numberFrom(env.OPENAI_MAX_RETRIES, 3),

    tryOnJobTimeoutMs: numberFrom(env.TRYON_JOB_TIMEOUT_MS, 180_000),
    jobTtlMs: numberFrom(env.JOB_TTL_MINUTES, 10) * 60_000,
    sessionTtlMs: numberFrom(env.SESSION_TTL_MINUTES, 15) * 60_000,

    faceCheck: booleanFrom(env.FACE_CHECK, true),
    faceCheckMinScore: numberFrom(env.FACE_CHECK_MIN_SCORE, 0.7),
    faceCheckRetries: numberFrom(env.FACE_CHECK_RETRIES, 1), // v1 routes
    // Mirror (v2) token savings, 7 Nov 2026. The face now comes from the visit's clearest close-up, placed
    // locally after the render (sidecar facetransfer.py), so the model needs no face image and a face that
    // fails the identity check is no reason to pay for another image.
    renderFaceReference: booleanFrom(env.RENDER_FACE_REFERENCE, false),
    renderRetries: Math.max(0, numberFrom(env.RENDER_RETRIES, 0)),
    requireFullBody: booleanFrom(env.REQUIRE_FULL_BODY, true),

    artifactsDir: path.resolve(projectRoot, env.ARTIFACTS_DIR || 'How do I look'),
    // Debug copies of v1 captures and results. Off by default: visitor photos stay in memory.
    retentionHours: numberFrom(env.RETENTION_HOURS, 0),
    wardrobeDir: path.resolve(projectRoot, env.WARDROBE_DIR || 'wardrobe'),
    catalogueDataDir: path.join(backendRoot, 'data'),
    projectRoot,

    sidecarUrl: (env.SIDECAR_URL || 'http://127.0.0.1:8765').replace(/\/$/, ''),
    sidecarToken: env.SIDECAR_TOKEN || '',
    sidecarSpawn: ['true', 'false'].includes(String(env.SIDECAR_SPAWN)) ? String(env.SIDECAR_SPAWN) : 'auto',
    sidecarDir: path.resolve(projectRoot, env.SIDECAR_DIR || 'sidecar'),
    autoEndOnLeave: booleanFrom(env.AUTO_END_ON_LEAVE, true),
    renderConcurrency: Math.max(1, numberFrom(env.RENDER_CONCURRENCY, 2)),
    // Streamed previews while an image renders: each adds ~100 output tokens. 0 by default (token saving).
    partialImages: Math.max(0, Math.min(3, numberFrom(env.PARTIAL_IMAGES, 0))),
    // false (default) = render a look only when the visitor asks for it: a look rendered ahead of time costs
    // ~2,700 tokens even if nobody sees it. dwell = render the next option after PREFETCH_DWELL_MS of viewing;
    // auto = whenever the queue is idle; true = always.
    prefetchOptions: ['true', 'dwell', 'auto'].includes(String(env.PREFETCH_OPTIONS)) ? String(env.PREFETCH_OPTIONS) : 'false',
    prefetchBudgetFraction: numberFrom(env.PREFETCH_BUDGET_FRACTION, 0.5),
    prefetchDwellMs: numberFrom(env.PREFETCH_DWELL_MS, 10_000),
    // Draft off by default: in real runs it cost ~30% of a final image to save 2-8 s.
    renderDraft: booleanFrom(env.RENDER_DRAFT, false),
    draftQuality: env.DRAFT_QUALITY || 'low',
    // Medium by default: in real use, low-quality renders looked rough enough to spoil the result (7 Nov
    // 2026). Medium costs about $0.06 an image against $0.02 for low. FINAL_QUALITY=low brings the cheap
    // setting back.
    finalQuality: env.FINAL_QUALITY || 'medium',
    // Per-look token budget: optional extra calls (face-check retries, drafts, early designs) only run if
    // they keep the look under LOOK_TOKEN_BUDGET. 4,500 fits a design plus a medium image (~3,650) but not a
    // second image. The original pipeline's 2,673 is still reported for comparison.
    originalTokensPerLook: 2673,
    lookTokenBudget: numberFrom(env.LOOK_TOKEN_BUDGET, 4500),
    earlyDesignMax: numberFrom(env.EARLY_DESIGN_MAX, 1),
    // A/B test: each visitor gets one of these final qualities, alternating; likes and real cost are
    // reported per quality. Empty = everyone gets FINAL_QUALITY.
    finalQualityExperiment: String(env.FINAL_QUALITY_EXPERIMENT ?? '').split(',').map((q) => q.trim()).filter(Boolean),
    // Design outfits from the early profile, before the photo is taken (~5 s faster first idea). Off by
    // default: a design started early is wasted (~900 tokens) whenever the visitor leaves before the photo.
    earlyDesign: booleanFrom(env.EARLY_DESIGN, false),
    // Likes needed for an undertone before its liked colours start steering palettes and option order.
    learnMinRatings: numberFrom(env.LEARN_MIN_RATINGS, 20),
    requireConsent: booleanFrom(env.REQUIRE_CONSENT, true),
    sidecarWatchdogMs: numberFrom(env.SIDECAR_WATCHDOG_MS, 20_000),
    openaiBaseUrl: (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    tls: env.TLS_CERT_FILE && env.TLS_KEY_FILE ? { certFile: env.TLS_CERT_FILE, keyFile: env.TLS_KEY_FILE } : null,
    // gpt-image-1.5 largely ignores the prompt inside a mask, so the default is an unmasked edit
    // that keeps the pose, followed by pasting the original head back when the render stayed aligned.
    renderMask: booleanFrom(env.RENDER_MASK, false),
    // Off by default. "high" keeps faces closer to the photo, but OpenAI then reads the photo at ~10,900 input
    // tokens: measured 7 Nov 2026, $0.15 an image instead of ~$0.06, and on a webcam capture the face was too
    // small (58 px) to benefit. The sharp close-up sent as a second image does that job for ~190 tokens.
    openaiInputFidelity: env.OPENAI_INPUT_FIDELITY === 'off' ? '' : env.OPENAI_INPUT_FIDELITY || '',
    // Lower reasoning effort makes the outfit-design call several times faster.
    openaiReasoningEffort: env.OPENAI_REASONING_EFFORT ?? 'low',

    dailyBudgetUsd: numberFrom(env.DAILY_BUDGET_USD, 30),
    // Pre-call estimates only (real cost is charged from token usage). Measured on real calls,
    // 6 Nov 2026: design ~$0.010, medium 1024x1536 image ~$0.058-0.065, low-quality draft ~$0.019.
    costs: {
      text: numberFrom(env.COST_TEXT_CALL_USD, 0.02),
      image: numberFrom(env.COST_IMAGE_USD, 0.065),
      draft: numberFrom(env.COST_DRAFT_IMAGE_USD, 0.02)
    },
    prices: env.PRICES_JSON ? JSON.parse(env.PRICES_JSON) : null,
    budgetWarnFraction: numberFrom(env.BUDGET_WARN_FRACTION, 0.8),
    runtimeDir: path.resolve(backendRoot, env.RUNTIME_DIR || '.runtime'),

    // Operations: alerts to a Slack-compatible webhook, daily log files, graceful shutdown.
    alertWebhookUrl: env.ALERT_WEBHOOK_URL || '',
    alertCooldownMs: numberFrom(env.ALERT_COOLDOWN_MINUTES, 15) * 60_000,
    alertName: env.ALERT_NAME || 'KYRA mirror',
    logDir: env.LOG_DIR === '' ? '' : path.resolve(backendRoot, env.LOG_DIR || '.runtime/logs'),
    logRetentionDays: numberFrom(env.LOG_RETENTION_DAYS, 14),
    shutdownGraceMs: numberFrom(env.SHUTDOWN_GRACE_MS, 30_000),

    keepHours: numberFrom(env.KEEP_HOURS, 24),
    // The sidecar's setting (passed on to it): how long out of view before a visit ends. Read here for /privacy.
    absentAfterMs: numberFrom(env.ABSENT_AFTER_MS, 30_000),
    publicBaseUrl: env.PUBLIC_BASE_URL || '',
    // Where the consent screen's QR code leads: the venue's own privacy notice. Empty: this backend's
    // /privacy page, when PUBLIC_BASE_URL says how phones reach it; otherwise the screen shows no QR.
    privacyUrl: env.PRIVACY_URL || '',

    // The team's kiosk UI (Kyra-UI-V1), built with `npm run build`, served at FRONTEND_PATH. FRONTEND_DIR=''
    // turns it off (for example when the UI is served some other way).
    frontendDir: env.FRONTEND_DIR === '' ? '' : path.resolve(projectRoot, env.FRONTEND_DIR || 'Kyra-UI-V1/dist'),
    frontendPath: env.FRONTEND_PATH || '/Kyra-UI-V1/'
  };
}
