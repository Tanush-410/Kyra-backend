import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { solidImage, syntheticPerson, testApp, waitForJob } from './helpers.js';

const json = (payload) => ({ method: 'POST', payload });

test('style-me: measures skin, designs an outfit and renders a face-checked try-on', async () => {
  const { app, openai } = await testApp();
  const photo = await syntheticPerson({ skin: [215, 170, 110] });

  const response = await app.inject({ url: '/api/style-me', ...json({ imageDataUrl: photo.dataUrl, style: 'formal', heightCm: 185 }) });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.equal(body.profile.skinToneSource, 'measured');
  assert.equal(body.profile.skinUndertone, 'warm');
  assert.equal(body.profile.heightImpression, 'tall');
  assert.equal(body.outfit.items.length, 3);
  assert.equal(body.optionNumber, 1);

  const designPrompt = openai.callsOf('design')[0].text;
  assert.match(designPrompt, /Measured skin colour \(CIELAB/);
  assert.match(designPrompt, /185 cm/);
  assert.equal(openai.callsOf('design')[0].text.includes('data:image'), false);

  const job = await waitForJob(app, body.virtualTryOnJobId);
  assert.equal(job.status, 'done');
  assert.equal(job.result.faceCheck.passed, true);
  assert.match(job.result.imageDataUrl, /^data:image\/png;base64,/);
  await app.close();
});

test('style-me: a black frame is rejected locally without any OpenAI call', async () => {
  const { app, openai } = await testApp();
  const response = await app.inject({ url: '/api/style-me', ...json({ imageDataUrl: (await solidImage([0, 0, 0])).dataUrl, style: 'casual' }) });
  assert.equal(response.statusCode, 422);
  assert.equal(response.json().code, 'retake');
  assert.equal(openai.calls.length, 0);
  await app.close();
});

test('style-me: unusable photos stop before design and image generation', async () => {
  const cases = [
    [{ personCount: 0 }, /No person/],
    [{ personCount: 3, singleProminentPerson: false, reason: '' }, /Several people/],
    [{ fullBodyVisible: false }, /whole body/],
    [{ usable: false, reason: 'Move into the light.' }, /Move into the light/]
  ];
  for (const [override, message] of cases) {
    const { app, openai } = await testApp({
      handlers: {
        assess: {
          usable: true,
          personCount: 1,
          singleProminentPerson: true,
          fullBodyVisible: true,
          faceVisible: true,
          faceBox: null,
          estimate: {},
          ...override
        }
      }
    });
    const response = await app.inject({ url: '/api/style-me', ...json({ imageDataUrl: (await syntheticPerson()).dataUrl, style: 'party' }) });
    assert.equal(response.statusCode, 422);
    assert.match(response.json().error, message);
    assert.equal(openai.callsOf('design').length + openai.callsOf('image').length, 0);
    await app.close();
  }
});

test('style-me: falls back to the visual estimate when the face cannot be measured', async () => {
  const { app } = await testApp({
    handlers: {
      assess: {
        usable: true,
        personCount: 1,
        singleProminentPerson: true,
        fullBodyVisible: true,
        faceVisible: true,
        faceBox: null,
        estimate: { skinUndertone: 'cool', skinDepth: 'tan' }
      }
    }
  });
  const response = await app.inject({ url: '/api/style-me', ...json({ imageDataUrl: (await syntheticPerson()).dataUrl, style: 'office' }) });
  assert.equal(response.json().profile.skinToneSource, 'estimated');
  assert.equal(response.json().profile.skinUndertone, 'cool');
  await app.close();
});

test('style-me next: reuses the session, avoids repeats and applies feedback and preferences', async () => {
  const { app, openai } = await testApp();
  const first = (
    await app.inject({
      url: '/api/style-me',
      ...json({ imageDataUrl: (await syntheticPerson()).dataUrl, style: 'party', preferences: { avoidColors: 'black, red', season: 'fall' } })
    })
  ).json();
  assert.deepEqual(first.preferences.avoidColors, ['black', 'red']);
  assert.equal(first.preferences.season, 'autumn');

  const second = await app.inject({
    url: `/api/style-me/${first.sessionId}/next`,
    ...json({ feedback: 'less formal please', preferences: { modesty: 'modest' } })
  });
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().optionNumber, 2);
  assert.notEqual(second.json().virtualTryOnJobId, first.virtualTryOnJobId);
  assert.deepEqual(second.json().preferences.avoidColors, ['black', 'red']);

  const prompt = openai.callsOf('design')[1].text;
  assert.match(prompt, /Already suggested[\s\S]*Olive blazer over cream shirt/);
  assert.match(prompt, /less formal please/);
  assert.match(prompt, /Never use these colours: black, red/);
  assert.match(prompt, /Coverage: modest/);
  assert.equal(openai.callsOf('assess').length, 1, 'no new photo analysis for another option');

  const missing = await app.inject({ url: '/api/style-me/00000000-0000-0000-0000-000000000000/next', ...json({}) });
  assert.equal(missing.statusCode, 404);
  await app.close();
});

test('style-me delete: removes the session and every file it wrote', async () => {
  const { app, artifactsDir } = await testApp();
  const first = (await app.inject({ url: '/api/style-me', ...json({ imageDataUrl: (await syntheticPerson()).dataUrl, style: 'casual' }) })).json();
  const job = await waitForJob(app, first.virtualTryOnJobId);
  const files = [first.artifacts.captureFile, first.artifacts.suggestionFile, job.result.imageFile, job.artifacts.virtualTryOnFile];
  assert.ok(files.every((file) => existsSync(path.join(artifactsDir, file))));

  const deleted = await app.inject({ method: 'DELETE', url: `/api/style-me/${first.sessionId}` });
  assert.equal(deleted.statusCode, 200);
  assert.equal(files.some((file) => existsSync(path.join(artifactsDir, file))), false);
  assert.equal((await app.inject({ url: `/api/virtual-tryon/${first.virtualTryOnJobId}` })).statusCode, 404);
  await app.close();
});

test('face check: a drifted face is regenerated and the best attempt is kept', async () => {
  const { app, openai } = await testApp({
    handlers: { faceCheck: (n) => ({ samePerson: n > 1, score: n > 1 ? 0.85 : 0.3, issues: n > 1 ? '' : 'jawline changed' }) }
  });
  const first = (await app.inject({ url: '/api/style-me', ...json({ imageDataUrl: (await syntheticPerson()).dataUrl, style: 'casual' }) })).json();
  const job = await waitForJob(app, first.virtualTryOnJobId);
  assert.equal(openai.callsOf('image').length, 2);
  assert.equal(job.result.faceCheck.passed, true);
  assert.equal(job.result.faceCheck.attempts, 2);
  await app.close();
});

test('face check: reports failure when every attempt drifts', async () => {
  const { app } = await testApp({ handlers: { faceCheck: { samePerson: false, score: 0.2, issues: 'different face' } } });
  const first = (await app.inject({ url: '/api/style-me', ...json({ imageDataUrl: (await syntheticPerson()).dataUrl, style: 'casual' }) })).json();
  const job = await waitForJob(app, first.virtualTryOnJobId);
  assert.equal(job.status, 'done');
  assert.equal(job.result.faceCheck.passed, false);
  assert.equal(job.result.faceCheck.issues, 'different face');
  await app.close();
});

test('auth: API_TOKEN protects /api routes but not /health', async () => {
  const { app } = await testApp({ env: { API_TOKEN: 'secret-token' } });
  const photo = (await solidImage([0, 0, 0])).dataUrl;
  assert.equal((await app.inject('/health')).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/style-me', ...json({ imageDataUrl: photo, style: 'x' }) })).statusCode, 401);
  const wrong = await app.inject({ url: '/api/style-me', headers: { authorization: 'Bearer nope' }, ...json({ imageDataUrl: photo, style: 'x' }) });
  assert.equal(wrong.statusCode, 401);
  const right = await app.inject({ url: '/api/style-me', headers: { authorization: 'Bearer secret-token' }, ...json({ imageDataUrl: photo, style: 'x' }) });
  assert.equal(right.statusCode, 422);
  const apiKeyHeader = await app.inject({ url: '/api/style-me', headers: { 'x-api-key': 'secret-token' }, ...json({ imageDataUrl: photo, style: 'x' }) });
  assert.equal(apiKeyHeader.statusCode, 422);
  await app.close();
});

test('rate limit: expensive routes are capped per client', async () => {
  const { app } = await testApp({ env: { RATE_LIMIT_MAX: '2' } });
  const photo = (await solidImage([0, 0, 0])).dataUrl;
  const codes = [];
  for (let i = 0; i < 3; i += 1) {
    codes.push((await app.inject({ url: '/api/outfit-review', ...json({ imageDataUrl: photo }) })).statusCode);
  }
  assert.deepEqual(codes, [422, 422, 429]);
  await app.close();
});

test('cors: allows local and Tauri origins only by default', async () => {
  const { app } = await testApp();
  const origin = async (value) => (await app.inject({ url: '/health', headers: { origin: value } })).headers['access-control-allow-origin'];
  assert.equal(await origin('http://localhost:5173'), 'http://localhost:5173');
  assert.equal(await origin('tauri://localhost'), 'tauri://localhost');
  assert.equal(await origin('https://evil.example'), undefined);
  await app.close();
});

test('outfit-review: keeps its response shape and saves artifacts', async () => {
  const { app } = await testApp({
    handlers: {
      review: {
        score: 7.26,
        summary: 'Neat smart-casual look.',
        visibleRegions: { top: true, bottom: true },
        cards: [
          { id: 'a', kind: 'works', area: 'top', title: 'Crisp collar', detail: 'Collar frames the face well.' },
          { id: 'b', kind: 'improve', area: 'shoes', title: 'Swap sneakers', detail: 'Try brown loafers instead.' },
          { id: 'c', kind: 'bogus', area: 'top', title: 'x', detail: 'y' }
        ]
      }
    }
  });
  const response = await app.inject({ url: '/api/outfit-review', ...json({ imageDataUrl: (await syntheticPerson()).dataUrl }) });
  const body = response.json();
  assert.equal(response.statusCode, 200);
  assert.equal(body.score, 7.3);
  assert.deepEqual(body.working, ['Crisp collar']);
  assert.deepEqual(body.notWorking, ['Swap sneakers']);
  assert.match(body.savedArtifacts.imageFile, /^images\/look-.*\.jpg$/);
  await app.close();
});

test('outfit-suggestion: explains missing wardrobe images with a 503', async () => {
  const { app, openai } = await testApp();
  const response = await app.inject({ url: '/api/outfit-suggestion', ...json({ imageDataUrl: (await syntheticPerson()).dataUrl, gender: 'male' }) });
  assert.equal(response.statusCode, 503);
  assert.match(response.json().error, /collage images were not found/);
  assert.equal(openai.calls.length, 0);
  await app.close();
});

test('retention 0: nothing is written to disk', async () => {
  const { app, artifactsDir } = await testApp({ env: { RETENTION_HOURS: '0' } });
  const first = (await app.inject({ url: '/api/style-me', ...json({ imageDataUrl: (await syntheticPerson()).dataUrl, style: 'casual' }) })).json();
  const job = await waitForJob(app, first.virtualTryOnJobId);
  assert.equal(job.status, 'done');
  assert.equal(first.artifacts.captureFile, null);
  assert.equal(existsSync(path.join(artifactsDir, 'outfit-flow')), false);
  await app.close();
});

test('privacy: the consent QR leads to PRIVACY_URL, else to /privacy when phones can reach it, else nowhere', async () => {
  const qrFor = async (env) => {
    const { app } = await testApp({ env: { API_TOKEN: 'kiosk', ...env } });
    const response = await app.inject({ url: '/api/v2/privacy', headers: { authorization: 'Bearer kiosk' } });
    const unauthorised = (await app.inject('/api/v2/privacy')).statusCode;
    await app.close();
    return { ...response.json(), unauthorised };
  };
  const own = await qrFor({ PRIVACY_URL: 'https://shop.example/privacy' });
  assert.equal(own.url, 'https://shop.example/privacy');
  assert.match(own.qrDataUrl, /^data:image\/png;base64,/);
  assert.equal(own.unauthorised, 401, 'the API needs the kiosk token like every /api route');
  assert.equal((await qrFor({ PUBLIC_BASE_URL: 'https://mirror.example:3000' })).url, 'https://mirror.example:3000/privacy');
  assert.deepEqual((await qrFor({})).url, null, 'localhost is no use to a phone: no QR');
  assert.equal((await qrFor({ PRIVACY_URL: 'javascript:alert(1)' })).url, null, 'only web addresses');
});

test('privacy: /privacy is public and says how long a kept look stays', async () => {
  const { app } = await testApp({ env: { API_TOKEN: 'kiosk', KEEP_HOURS: '24', ALLOWED_HOSTS: 'mirror.example' } });
  const page = await app.inject({ url: '/privacy', headers: { host: 'mirror.example' } });
  assert.equal(page.statusCode, 200, 'phones open it without the kiosk token');
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.body, /deleted after 24 hours/);
  assert.match(page.body, /OpenAI/);
  assert.match(page.body, /about 40 seconds after you step away/, 'ABSENT_AFTER_MS + LEAVE_GRACE_MS defaults: 10 s + 30 s');
  assert.match(page.body, /Until you agree on its screen, nothing it sees is saved or sent anywhere/);
  assert.match(page.body, /voice search, your words are turned into text by your browser's speech service \(Google, in Chrome\)/);
  assert.match(page.body, /keeps it only for this visit/);
  assert.doesNotMatch(page.body, /takes no photo/, 'the camera runs before consent (it guides, keeps a face crop in memory)');
  await app.close();
  const none = await testApp({ env: { KEEP_HOURS: '0', ABSENT_AFTER_MS: '90000', LEAVE_GRACE_MS: '30000' } });
  const other = (await none.app.inject('/privacy')).body;
  assert.match(other, /cannot be taken home/);
  assert.match(other, /about 2 minutes after you step away/);
  await none.app.close();
});
