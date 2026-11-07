import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpenAI } from '../src/lib/openai.js';

function scripted(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next instanceof Error) {
      throw next;
    }
    return new Response(JSON.stringify(next.body), { status: next.status, headers: next.headers || {} });
  };
  return { fetchImpl, calls };
}

const ok = { status: 200, body: { output_text: 'hello' } };

function client(fetchImpl, sleeps = [], overrides = {}) {
  return createOpenAI({ apiKey: 'k', model: 'm', imageModel: 'i', maxRetries: 3, fetchImpl, sleep: async (ms) => sleeps.push(ms), ...overrides });
}

test('retries rate limits and server errors, then succeeds', async () => {
  const { fetchImpl, calls } = scripted([{ status: 429, body: {} }, { status: 503, body: {} }, ok]);
  const sleeps = [];
  assert.equal(await client(fetchImpl, sleeps).respond({ text: 'hi' }), 'hello');
  assert.equal(calls.length, 3);
  assert.equal(sleeps.length, 2);
});

test('honours retry-after headers', async () => {
  const { fetchImpl } = scripted([{ status: 429, body: {}, headers: { 'retry-after': '2' } }, ok]);
  const sleeps = [];
  await client(fetchImpl, sleeps).respond({ text: 'hi' });
  assert.deepEqual(sleeps, [2000]);
});

test('does not retry client errors or exhausted quota', async () => {
  const badRequest = scripted([{ status: 400, body: { error: { message: 'bad' } } }]);
  await assert.rejects(client(badRequest.fetchImpl).respond({ text: 'hi' }), { message: 'bad', status: 400 });
  assert.equal(badRequest.calls.length, 1);

  const quota = scripted([{ status: 429, body: { error: { code: 'insufficient_quota', message: 'quota' } } }]);
  await assert.rejects(client(quota.fetchImpl).respond({ text: 'hi' }), { status: 429 });
  assert.equal(quota.calls.length, 1);
});

test('gives up after maxRetries and retries network errors', async () => {
  const { fetchImpl, calls } = scripted([new TypeError('socket hang up')]);
  await assert.rejects(client(fetchImpl).respond({ text: 'hi' }), /socket hang up/);
  assert.equal(calls.length, 4);
});

test('rebuilds multipart bodies on each image retry', async () => {
  const { fetchImpl, calls } = scripted([{ status: 500, body: {} }, { status: 200, body: { data: [{ b64_json: 'abc' }] } }]);
  const result = await client(fetchImpl).editImage({
    prompt: 'p',
    images: [{ dataUrl: 'data:image/png;base64,AAAA', filename: 'a.png' }]
  });
  assert.equal(result, 'abc');
  assert.notEqual(calls[0].init.body, calls[1].init.body);
  assert.equal(calls[1].init.body.get('model'), 'i');
});

test('fails fast without an API key', async () => {
  await assert.rejects(client(async () => assert.fail('should not fetch'), [], { apiKey: '' }).respond({ text: 'x' }), /OPENAI_API_KEY/);
});
