import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const MAX_SAMPLES = 200;

// Rolling per-step timings and counters for /api/v2/metrics and the logs. With a file, they are saved
// now and then and restored on start, so a restart does not wipe the dashboard.
export function createMetrics({ file = null } = {}) {
  const steps = new Map();
  const counters = new Map();

  if (file && existsSync(file)) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      for (const [step, samples] of Object.entries(saved.steps || {})) {
        if (Array.isArray(samples)) {
          steps.set(step, samples.filter(Number.isFinite).slice(-MAX_SAMPLES));
        }
      }
      for (const [name, value] of Object.entries(saved.counters || {})) {
        if (Number.isFinite(value)) {
          counters.set(name, value);
        }
      }
    } catch {
      // A corrupt snapshot only costs history.
    }
  }

  return {
    save() {
      if (!file) {
        return;
      }
      try {
        mkdirSync(path.dirname(file), { recursive: true });
        const temp = `${file}.tmp`;
        writeFileSync(temp, JSON.stringify({ savedAt: new Date().toISOString(), steps: Object.fromEntries(steps), counters: Object.fromEntries(counters) }));
        renameSync(temp, file); // atomic: a crash mid-write never leaves a half file
      } catch {
        // Metrics are best effort.
      }
    },

    time(step, ms) {
      const samples = steps.get(step) || [];
      samples.push(ms);
      if (samples.length > MAX_SAMPLES) {
        samples.shift();
      }
      steps.set(step, samples);
    },

    count(name, by = 1) {
      counters.set(name, (counters.get(name) || 0) + by);
    },

    summary() {
      const stepSummary = {};
      for (const [step, samples] of steps) {
        const sorted = [...samples].sort((a, b) => a - b);
        const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
        stepSummary[step] = {
          count: samples.length,
          avgMs: Math.round(samples.reduce((sum, ms) => sum + ms, 0) / samples.length),
          p50Ms: Math.round(pick(0.5)),
          p90Ms: Math.round(pick(0.9))
        };
      }
      return { steps: stepSummary, counters: Object.fromEntries(counters) };
    }
  };
}
