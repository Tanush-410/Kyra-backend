import { randomUUID } from 'node:crypto';
import { bufferToDataUrl } from './normalize.js';
import { STORAGE_DIRS } from './storage.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Jobs live in memory for `ttlMs` after they settle; a record on disk lets polling survive a restart.
export function createJobStore({ storage, timeoutMs, ttlMs }) {
  const jobs = new Map();
  const timers = new Map();

  function persist(job) {
    const { imageDataUrl, ...result } = job.result || {};
    const recordFile = storage.saveJson('jobs', `${job.jobId}.json`, {
      ...job,
      result: job.result ? result : null
    });
    return recordFile;
  }

  function settle(jobId, changes) {
    const existing = jobs.get(jobId);
    // A job settles once: a late result cannot flip a timed-out job, and a late timeout cannot fail a finished one.
    if (!existing || existing.status !== 'processing') {
      return null;
    }
    clearTimeout(timers.get(jobId));
    timers.delete(jobId);

    const settled = { ...existing, ...changes, settledAt: new Date().toISOString() };
    const recordFile = persist(settled);
    const job = recordFile
      ? { ...settled, artifacts: { ...(settled.artifacts || {}), virtualTryOnFile: recordFile } }
      : settled;
    jobs.set(jobId, job);
    return job;
  }

  return {
    create(fields) {
      const jobId = randomUUID();
      const job = {
        jobId,
        status: 'processing',
        createdAt: new Date().toISOString(),
        ...fields,
        artifacts: fields.artifacts || {},
        result: null,
        error: ''
      };
      jobs.set(jobId, job);
      persist(job);
      timers.set(
        jobId,
        setTimeout(() => settle(jobId, { status: 'failed', error: 'Virtual try-on timed out. Please try again.' }), timeoutMs)
      );
      return job;
    },

    get(jobId) {
      if (!UUID_PATTERN.test(String(jobId || ''))) {
        return null;
      }
      if (jobs.has(jobId)) {
        return jobs.get(jobId);
      }

      const record = storage.readJson('jobs', `${jobId}.json`);
      if (!record) {
        return null;
      }
      if (record.status === 'processing') {
        return { ...record, status: 'failed', error: 'The server restarted before this try-on finished. Please try again.' };
      }
      if (record.status === 'done' && record.result?.imageFile) {
        const image = storage.readBuffer(record.result.imageFile);
        return image ? { ...record, result: { ...record.result, imageDataUrl: bufferToDataUrl(image) } } : record;
      }
      return record;
    },

    complete(jobId, { artifacts, result }) {
      const existing = jobs.get(jobId);
      return settle(jobId, {
        status: 'done',
        artifacts: { ...(existing?.artifacts || {}), ...artifacts },
        result,
        error: ''
      });
    },

    fail(jobId, error) {
      return settle(jobId, { status: 'failed', error });
    },

    remove(jobId) {
      clearTimeout(timers.get(jobId));
      timers.delete(jobId);
      const job = jobs.get(jobId) || storage.readJson('jobs', `${jobId}.json`);
      jobs.delete(jobId);
      storage.deleteFiles([`${STORAGE_DIRS.jobs}/${jobId}.json`]);
      return job;
    },

    sweep(now = Date.now()) {
      let removed = 0;
      for (const [jobId, job] of jobs) {
        if (job.status !== 'processing' && now - Date.parse(job.settledAt || job.createdAt) > ttlMs) {
          jobs.delete(jobId);
          removed += 1;
        }
      }
      return removed;
    },

    size() {
      return jobs.size;
    },

    close() {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
    }
  };
}
