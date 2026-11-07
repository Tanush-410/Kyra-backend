import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export class SidecarError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'SidecarError';
    this.status = status;
  }
}

// Client for the Python perception sidecar (camera, pose, face mesh, masks, face identity).
export function createSidecar({ url, token, timeoutMs = 20_000, fetchImpl = (...args) => globalThis.fetch(...args), log }) {
  // x-kyra-client marks requests as the backend's: the sidecar refuses changes without it (or a token),
  // because a web page cannot add a custom header without a CORS preflight.
  let headers = {};
  const setToken = (value) => {
    headers = { 'x-kyra-client': 'kyra-backend', ...(value ? { 'x-sidecar-token': value } : {}) };
  };
  setToken(token);
  let subscription = null;

  async function call(method, pathname, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${url}${pathname}`, {
        method,
        headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new SidecarError(json?.detail || `Sidecar ${pathname} failed with ${response.status}`, response.status);
      }
      return json;
    } catch (error) {
      if (error instanceof SidecarError) {
        throw error;
      }
      throw new SidecarError(error?.name === 'AbortError' ? 'Sidecar timed out.' : `Sidecar unreachable: ${error?.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  // Follows the sidecar's SSE stream, reconnecting with backoff. onEvent(event) gets parsed events.
  function subscribe(onEvent, onStatus = () => {}) {
    let stopped = false;
    let controller = null;

    (async () => {
      let delay = 500;
      while (!stopped) {
        controller = new AbortController();
        try {
          const response = await fetchImpl(`${url}/events`, { headers, signal: controller.signal });
          if (!response.ok || !response.body) {
            throw new Error(`status ${response.status}`);
          }
          onStatus('connected');
          delay = 500;
          const decoder = new TextDecoder();
          let buffer = '';
          for await (const chunk of response.body) {
            buffer += decoder.decode(chunk, { stream: true });
            let boundary;
            while ((boundary = buffer.indexOf('\n\n')) >= 0) {
              const block = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('');
              if (data) {
                try {
                  onEvent(JSON.parse(data));
                } catch (error) {
                  log?.warn({ error: error?.message }, 'Bad sidecar event');
                }
              }
            }
          }
        } catch (error) {
          if (stopped) {
            break;
          }
          log?.debug?.({ error: error?.message }, 'Sidecar event stream unavailable');
        }
        if (!stopped) {
          onStatus('disconnected');
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay = Math.min(delay * 2, 10_000);
        }
      }
    })();

    subscription = {
      stop() {
        stopped = true;
        controller?.abort();
      }
    };
    return subscription;
  }

  return {
    url,
    health: () => call('GET', '/health'),
    analyze: (imageDataUrl) => call('POST', '/analyze', { imageDataUrl }),
    segment: (imageDataUrl) => call('POST', '/segment', { imageDataUrl }),
    compareFaces: (referenceDataUrl, imageDataUrl) => call('POST', '/face/compare', { referenceDataUrl, imageDataUrl }),
    compose: (body) => call('POST', '/compose', body),
    arm: (sessionId) => call('POST', '/arm', { sessionId }),
    disarm: () => call('POST', '/disarm'),
    captureNow: () => call('POST', '/capture'),
    getCapture: (captureId) => call('GET', `/captures/${captureId}`),
    deleteCapture: (captureId) => call('DELETE', `/captures/${captureId}`),
    calibration: () => call('GET', '/calibration'),
    resetCalibration: () => call('DELETE', '/calibration'),
    calibrateHeight: (body) => call('POST', '/calibrate/height', body),
    calibrateWhiteBalance: (body) => call('POST', '/calibrate/white-balance', body),
    calibrateUndertone: (body) => call('POST', '/calibrate/undertone', body),
    setToken,
    preview: () => fetchImpl(`${url}/preview.mjpg`, { headers }),
    subscribe,
    close() {
      subscription?.stop();
    }
  };
}

// Starts the sidecar from ../sidecar/.venv when it is not already running.
// Returns { spawned, stop, restart }; restart() kills the process and the exit handler starts a new one.
// A sidecar that ran this long before exiting counts as having been healthy: its crash count starts again.
const STABLE_UPTIME_MS = 2 * 60_000;
const FAST_RESTARTS = 5;
const SLOW_RESTART_MS = 5 * 60_000;

// After an exit: the crash count (reset if the sidecar had been up a while) and how long to wait. Quick
// retries first; after that it keeps trying every few minutes instead of giving up for the day.
export function restartPlan(previousRestarts, uptimeMs) {
  const restarts = (uptimeMs > STABLE_UPTIME_MS ? 0 : previousRestarts) + 1;
  return { restarts, delayMs: restarts <= FAST_RESTARTS ? Math.min(30_000, 1000 * 2 ** restarts) : SLOW_RESTART_MS };
}

// The sidecar's own settings (see sidecar/kyra_sidecar/config.py and color.py). Everything else, notably
// OPENAI_API_KEY, API_TOKEN, OPERATOR_TOKEN and ALERT_WEBHOOK_URL, stays out of its environment.
const SIDECAR_ENV = /^(PATH|HOME|USER|LOGNAME|LANG|LC_[A-Z]+|TMPDIR|TZ|PYTHON[A-Z_]*|SIDECAR_[A-Z_]+|CAMERA(_[A-Z]+)?|ANALYSIS_WIDTH|TARGET_FPS|READY_HOLD_MS|SKIN_FRAMES|SKIN_COOL_MAX_HUE|SKIN_WARM_MIN_HUE|UNDERTONE_ENGINE|ABSENT_AFTER_MS|CAPTURE_TTL_S|GESTURES|GESTURE_HOLD_MS|GESTURE_COOLDOWN_MS|FREEZE_AFTER_S|MODELS_DIR|CALIBRATION_PATH|OPENCV_[A-Z_]+)$/;

export function sidecarEnv(env, { port, token = '' }) {
  const picked = Object.fromEntries(Object.entries(env).filter(([key]) => SIDECAR_ENV.test(key)));
  return { ...picked, SIDECAR_PORT: String(port), ...(token ? { SIDECAR_TOKEN: token } : {}) };
}

export async function maybeSpawnSidecar({ mode, sidecarDir, client, port, log, token = '', onExit = () => {} }) {
  const none = { spawned: false, stop: () => {}, restart: () => {} };
  if (mode === 'false') {
    return none;
  }
  try {
    await client.health();
    log.info('Sidecar already running');
    return none;
  } catch {
    // not running yet
  }

  const python = path.join(sidecarDir, '.venv', 'bin', 'python');
  if (!existsSync(python)) {
    if (mode === 'true') {
      log.error({ python }, 'SIDECAR_SPAWN=true but the sidecar virtualenv was not found');
    }
    return none;
  }

  let child = null;
  let stopping = false;
  let restarts = 0;
  let startedAt = 0;

  const start = () => {
    startedAt = Date.now();
    child = spawn(python, ['-m', 'kyra_sidecar'], {
      cwd: sidecarDir,
      env: sidecarEnv(process.env, { port, token }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const relay = (stream, level) =>
      stream.on('data', (chunk) => {
        for (const line of String(chunk).split('\n')) {
          // MediaPipe and TFLite print noisy native logs; keep only the sidecar's own lines.
          if (line.trim() && !/^(I0000|W0000|INFO: Created|\[ WARN)/.test(line)) {
            log[level]({ sidecar: true }, line);
          }
        }
      });
    relay(child.stdout, 'info');
    relay(child.stderr, 'info');
    child.on('exit', (code, signal) => {
      if (stopping) {
        return;
      }
      const plan = restartPlan(restarts, Date.now() - startedAt);
      restarts = plan.restarts;
      const { delayMs } = plan;
      log.error({ code, signal, restarts, retryInMs: delayMs }, 'Sidecar exited; restarting');
      onExit({ code, signal, restarts, retryInMs: delayMs });
      setTimeout(() => {
        if (!stopping) {
          start();
        }
      }, delayMs).unref?.();
    });
  };

  // Only a sidecar we start gets the generated token; one already running keeps its own settings.
  if (token) {
    client.setToken(token);
  }
  start();
  log.info({ pid: child.pid, token: Boolean(token) }, 'Spawned perception sidecar');
  return {
    spawned: true,
    stop() {
      stopping = true;
      child?.kill('SIGTERM');
    },
    restart() {
      restarts = 0;
      child?.kill('SIGKILL');
    }
  };
}
