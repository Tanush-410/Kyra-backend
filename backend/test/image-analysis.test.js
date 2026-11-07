import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkImageQuality, measureSkinTone } from '../src/lib/image-analysis.js';
import { FACE_BOX, solidImage, syntheticPerson } from './helpers.js';

test('quality check rejects black, blank, overexposed and tiny photos', async () => {
  assert.match((await checkImageQuality((await solidImage([0, 0, 0])).buffer)).reason, /too dark/);
  assert.match((await checkImageQuality((await solidImage([250, 250, 250])).buffer)).reason, /overexposed/);
  assert.match((await checkImageQuality((await solidImage([128, 128, 128])).buffer)).reason, /blank/);
  assert.match((await checkImageQuality((await solidImage([128, 90, 90], 100)).buffer)).reason, /resolution/);
  assert.match((await checkImageQuality(Buffer.from('not an image'))).reason, /Could not read/);
});

test('quality check accepts a normal photo', async () => {
  const result = await checkImageQuality((await syntheticPerson()).buffer);
  assert.equal(result.usable, true);
});

test('yellow-leaning skin measures warm and pink-leaning skin measures cool', async () => {
  const warm = await measureSkinTone((await syntheticPerson({ skin: [215, 170, 110] })).buffer, FACE_BOX);
  const cool = await measureSkinTone((await syntheticPerson({ skin: [225, 165, 160] })).buffer, FACE_BOX);
  assert.equal(warm.skinUndertone, 'warm');
  assert.equal(cool.skinUndertone, 'cool');
  assert.ok(warm.hueAngle > cool.hueAngle);
  assert.equal(warm.method, 'measured');
});

test('lighter skin has a higher ITA and lighter depth than deeper skin', async () => {
  const light = await measureSkinTone((await syntheticPerson({ skin: [235, 200, 175] })).buffer, FACE_BOX);
  const deep = await measureSkinTone((await syntheticPerson({ skin: [110, 70, 50] })).buffer, FACE_BOX);
  assert.ok(light.ita > deep.ita);
  assert.ok(['fair', 'light'].includes(light.skinDepth));
  assert.equal(deep.skinDepth, 'deep');
});

test('white balance correction cancels a warm lighting cast', async () => {
  const skin = [200, 160, 135];
  const neutral = await measureSkinTone((await syntheticPerson({ skin })).buffer, FACE_BOX);
  const warmLights = await measureSkinTone((await syntheticPerson({ skin, cast: [1.12, 1, 0.85] })).buffer, FACE_BOX);
  assert.ok(warmLights.whiteBalanceGains.b > 1.05, 'should boost blue under warm light');
  assert.ok(Math.abs(warmLights.hueAngle - neutral.hueAngle) < 4, `hue drifted: ${neutral.hueAngle} vs ${warmLights.hueAngle}`);
  assert.equal(warmLights.skinUndertone, neutral.skinUndertone);
});

test('measurement returns null without a usable face box or skin pixels', async () => {
  const { buffer } = await syntheticPerson();
  assert.equal(await measureSkinTone(buffer, null), null);
  assert.equal(await measureSkinTone(buffer, { x: 0.9, y: 0.9, width: 0.5, height: 0.5 }), null);
  assert.equal(await measureSkinTone(buffer, { x: 0.35, y: 0.35, width: 0.3, height: 0.3 }), null);
});
