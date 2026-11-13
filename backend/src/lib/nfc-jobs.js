// KYRA NFC TAGS (2 of 3): tag-programming jobs, between the kiosk and the Raspberry Pi tag writer.
//
// The kiosk asks for a tag (create); the Pi polls for work (claim), then reports each step (report):
//   queued -> waiting_for_tag -> writing -> verifying -> succeeded
//                                     \-> failed (any active state) / cancelled (by the kiosk)
// "succeeded" is only accepted after "verifying": the Pi read the tag back and it held the exact URL.
// Jobs persist to <dir>/jobs.json (no database), and every programmed tag is logged to <dir>/tags.jsonl
// (job, session, link, tag UID as metadata: a UID is not a credential, it's for support).
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const ACTIVE = ['queued', 'waiting_for_tag', 'writing', 'verifying'];
const NEXT = {
  queued: ['waiting_for_tag', 'failed', 'cancelled'],
  waiting_for_tag: ['writing', 'failed', 'cancelled'],
  writing: ['verifying', 'failed', 'cancelled'],
  verifying: ['succeeded', 'failed'],
  succeeded: [],
  failed: [],
  cancelled: []
};
const ONLINE_MS = 30_000; // a device that polled in the last 30 s counts as online

export function createTagJobs({ dir, timeoutMs = 3 * 60_000, onChange = () => {} }) {
  const file = dir ? path.join(dir, 'jobs.json') : null;
  const jobs = new Map();
  const seen = new Map(); // deviceId -> last poll
  if (file && existsSync(file)) {
    try {
      for (const job of JSON.parse(readFileSync(file, 'utf8'))) jobs.set(job.id, job);
    } catch {
      // unreadable: start empty
    }
  }
  const save = () => {
    if (!file) return;
    mkdirSync(dir, { recursive: true });
    // Finished jobs are kept a day for support, then dropped.
    const keep = [...jobs.values()].filter((j) => ACTIVE.includes(j.status) || Date.now() - Date.parse(j.updatedAt) < 86_400_000);
    writeFileSync(file, JSON.stringify(keep));
  };
  const set = (job, patch) => {
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    if (!ACTIVE.includes(job.status)) job.completedAt = job.updatedAt;
    save();
    onChange(job);
    return job;
  };
  const expire = () => {
    for (const job of jobs.values()) {
      if (ACTIVE.includes(job.status) && Date.now() - Date.parse(job.createdAt) > timeoutMs) {
        set(job, { status: 'failed', error: 'timed_out' });
      }
    }
  };

  return {
    /** One job per session at a time: asking again returns the active one. */
    create({ sessionId, linkToken, url }) {
      expire();
      const active = [...jobs.values()].find((j) => j.sessionId === sessionId && ACTIVE.includes(j.status));
      if (active) return active;
      const now = new Date().toISOString();
      const job = { id: randomBytes(9).toString('base64url'), sessionId, linkToken, requestedUrl: url, status: 'queued', deviceId: null, createdAt: now, updatedAt: now, completedAt: null, error: null, tagUid: null };
      jobs.set(job.id, job);
      save();
      onChange(job);
      return job;
    },

    get(id) {
      expire();
      return jobs.get(id) || null;
    },

    /** A device asks for work: the oldest queued job becomes its job (waiting for a blank tag). */
    claim(deviceId) {
      seen.set(deviceId, Date.now());
      expire();
      const mine = [...jobs.values()].find((j) => j.deviceId === deviceId && ['waiting_for_tag', 'writing', 'verifying'].includes(j.status));
      if (mine) return mine; // the device restarted mid-job: give it the same job back
      const next = [...jobs.values()].filter((j) => j.status === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      return next ? set(next, { status: 'waiting_for_tag', deviceId }) : null;
    },

    /** A device reports a step. Only its own job, only forward. Returns { job } or { error }. */
    report(id, deviceId, { status, error = null, tagUid = null }) {
      seen.set(deviceId, Date.now());
      const job = jobs.get(id);
      if (!job) return { error: 'unknown_job' };
      if (job.deviceId !== deviceId) return { error: 'not_your_job' };
      if (job.status === status) return { job }; // a repeated report (a retry after a network error)
      if (!NEXT[job.status]?.includes(status)) return { error: 'invalid_transition' };
      const patch = { status, ...(status === 'failed' ? { error: String(error || 'write_failed').slice(0, 80) } : {}), ...(tagUid ? { tagUid: String(tagUid).slice(0, 32) } : {}) };
      set(job, patch);
      if (status === 'succeeded' && dir) {
        appendFileSync(path.join(dir, 'tags.jsonl'), `${JSON.stringify({ jobId: job.id, sessionId: job.sessionId, linkToken: job.linkToken, tagUid: job.tagUid, programmedAt: job.completedAt })}\n`);
      }
      return { job };
    },

    cancel(id) {
      const job = jobs.get(id);
      if (!job || !NEXT[job.status]?.includes('cancelled')) return job || null;
      return set(job, { status: 'cancelled' });
    },

    deviceOnline() {
      return [...seen.values()].some((at) => Date.now() - at < ONLINE_MS);
    }
  };
}

/** What the kiosk gets: no device or session details. */
export function publicJob(job) {
  return job && { jobId: job.id, status: job.status, error: job.error, url: job.requestedUrl, completedAt: job.completedAt };
}
