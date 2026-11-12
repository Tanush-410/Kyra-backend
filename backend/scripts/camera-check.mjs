// Is the camera the right way up? Stand facing it (1-2 m away) while the backend runs, then:
//   npm run camera-check            says which CAMERA_ROTATION the camera needs
//   npm run camera-check -- --apply  also writes it to backend/.env (then restart the backend)
// It looks for an upright face in the live picture at all four angles, so it works however the camera
// was turned (90 and 270 are easy to mix up by eye).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { backendRoot, loadConfig, loadLocalEnv } from '../src/config.js';
import { ensureTokens } from '../src/lib/secrets.js';

const apply = process.argv.includes('--apply');
loadLocalEnv();
const { config } = ensureTokens(loadConfig());
const token = config.operatorToken || config.apiToken;
const url = `http://localhost:${config.port}/api/v2/calibration/orientation`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let result;
for (let attempt = 1; attempt <= 10; attempt += 1) {
  let response;
  try {
    response = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  } catch {
    console.error(`The backend isn't running on port ${config.port}. Start it (npm start), then run this again.`);
    process.exit(1);
  }
  result = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error(`Camera check failed: ${result.error || response.status}`);
    process.exit(1);
  }
  if (result.found) break;
  if (attempt === 1) console.log('Looking for a face… stand facing the camera, about 1-2 m away.');
  await sleep(1000);
}

if (!result.found) {
  console.log(result.message);
  process.exit(1);
}
console.log(`Camera rotation now: ${result.current}. Needed: ${result.suggested}.`);
if (result.correct) {
  console.log('The camera is the right way up. Nothing to change.');
  process.exit(0);
}
if (!apply) {
  console.log(`Set CAMERA_ROTATION=${result.suggested} in backend/.env and restart the backend,`);
  console.log('or run: npm run camera-check -- --apply');
  process.exit(0);
}

const envFile = path.join(backendRoot, '.env');
const lines = existsSync(envFile) ? readFileSync(envFile, 'utf8').split('\n') : [];
const at = lines.findIndex((line) => /^\s*CAMERA_ROTATION\s*=/.test(line));
const line = `CAMERA_ROTATION=${result.suggested}`;
if (at >= 0) lines[at] = line;
else lines.splice(lines.at(-1) === '' ? lines.length - 1 : lines.length, 0, line);
writeFileSync(envFile, lines.join('\n'), { mode: 0o600 });
console.log(`Wrote ${line} to backend/.env. Restart the backend (Ctrl+C, then npm start) to use it.`);
if (process.env.CAMERA_ROTATION !== undefined) {
  console.log(`Note: your shell also sets CAMERA_ROTATION=${process.env.CAMERA_ROTATION}, which wins over .env. Unset it.`);
}
