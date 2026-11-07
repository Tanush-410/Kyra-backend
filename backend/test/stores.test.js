import assert from 'node:assert/strict';
import { existsSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createJobStore } from '../src/lib/jobs.js';
import { createSessionStore } from '../src/lib/sessions.js';
import { createStorage } from '../src/lib/storage.js';
import { TINY_PNG_BASE64, tempDir } from './helpers.js';

test('storage sweeps files past retention and keeps recent ones', () => {
  const storage = createStorage({ artifactsDir: tempDir(), retentionHours: 1 });
  const oldFile = storage.saveText('captures', 'old.txt', 'x');
  const newFile = storage.saveText('captures', 'new.txt', 'x');
  const twoHoursAgo = (Date.now() - 2 * 3_600_000) / 1000;
  utimesSync(path.join(storage.root, oldFile), twoHoursAgo, twoHoursAgo);

  assert.equal(storage.sweepExpired(), 1);
  assert.equal(existsSync(path.join(storage.root, oldFile)), false);
  assert.equal(existsSync(path.join(storage.root, newFile)), true);
});

test('storage with zero retention writes nothing', () => {
  const storage = createStorage({ artifactsDir: tempDir(), retentionHours: 0 });
  assert.equal(storage.saveText('captures', 'a.txt', 'x'), null);
  assert.equal(storage.enabled, false);
});

test('storage refuses to delete outside its root', () => {
  const outside = createStorage({ artifactsDir: tempDir(), retentionHours: 1 });
  const victim = outside.saveText('captures', 'keep.txt', 'x');
  const storage = createStorage({ artifactsDir: tempDir(), retentionHours: 1 });
  assert.equal(storage.deleteFiles([path.join(outside.root, victim), '../../etc/hosts']), 0);
  assert.equal(existsSync(path.join(outside.root, victim)), true);
});

test('a job settles once: late results cannot override a timeout', async () => {
  const jobs = createJobStore({ storage: createStorage({ artifactsDir: tempDir(), retentionHours: 1 }), timeoutMs: 10, ttlMs: 1000 });
  const job = jobs.create({ kind: 'test' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(jobs.get(job.jobId).status, 'failed');
  assert.equal(jobs.complete(job.jobId, { result: { imageDataUrl: 'x' } }), null);
  assert.equal(jobs.get(job.jobId).status, 'failed');
  jobs.close();
});

test('jobs are evicted from memory after their TTL but still readable from disk', () => {
  const storage = createStorage({ artifactsDir: tempDir(), retentionHours: 1 });
  const jobs = createJobStore({ storage, timeoutMs: 60_000, ttlMs: 1000 });
  const job = jobs.create({ kind: 'test' });
  const imageFile = storage.saveBuffer('generated', 'g.png', Buffer.from(TINY_PNG_BASE64, 'base64'));
  jobs.complete(job.jobId, { result: { imageFile, imageDataUrl: 'data:image/png;base64,abc' } });

  assert.equal(jobs.sweep(Date.now() + 2000), 1);
  assert.equal(jobs.size(), 0);
  const restored = jobs.get(job.jobId);
  assert.equal(restored.status, 'done');
  assert.equal(restored.result.imageDataUrl, `data:image/png;base64,${TINY_PNG_BASE64}`);
  jobs.close();
});

test('a job still processing when the server restarted reads as failed', () => {
  const storage = createStorage({ artifactsDir: tempDir(), retentionHours: 1 });
  const before = createJobStore({ storage, timeoutMs: 60_000, ttlMs: 1000 });
  const job = before.create({ kind: 'test' });
  before.close();

  const after = createJobStore({ storage, timeoutMs: 60_000, ttlMs: 1000 });
  assert.equal(after.get(job.jobId).status, 'failed');
  assert.match(after.get(job.jobId).error, /restarted/);
  assert.equal(after.get('../../etc/passwd'), null);
});

test('budget reserves the cost of calls in flight so parallel calls cannot overspend', async () => {
  const { createBudget } = await import('../src/lib/budget.js');
  const budget = createBudget({ file: null, dailyUsd: 0.06, costs: { text: 0.02, image: 0.05 } });
  budget.assert('text');
  assert.equal(budget.canSpend('image'), false, 'text in flight ($0.02) + image ($0.05) > $0.06');
  budget.record('text', 0.004);
  assert.equal(budget.canSpend('image'), true, 'real cost $0.004 + $0.05 fits');
  budget.assert('image');
  budget.release('image');
  assert.equal(budget.summary().spentUsd, 0.004, 'a failed call is not charged');
});

test('sessions expire after inactivity', () => {
  const sessions = createSessionStore({ ttlMs: 1000 });
  const session = sessions.create({ style: 'formal' });
  assert.equal(sessions.sweep(Date.now() + 500).length, 0);
  assert.equal(sessions.sweep(Date.now() + 1500).length, 1);
  assert.equal(sessions.get(session.sessionId), null);
});
