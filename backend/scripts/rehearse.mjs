// Free rehearsal: runs the mock OpenAI server and the backend pointed at it, in one command.
// Nothing is sent to OpenAI and nothing is charged. Ctrl+C stops both.
// Usage: npm run rehearse   (the camera sidecar starts as usual)
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOCK_PORT = 4010;
const children = [];

function run(name, args, env = {}) {
  const child = spawn(process.execPath, args, { cwd: backendRoot, env: { ...process.env, ...env }, stdio: 'inherit' });
  child.on('exit', (code) => {
    console.log(`[rehearse] ${name} exited (${code}); stopping`);
    stop(code ?? 0);
  });
  children.push(child);
}

function stop(code) {
  for (const child of children) {
    child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 500);
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

run('mock OpenAI', ['scripts/mock-openai.mjs', String(MOCK_PORT)]);
run('backend', ['src/server.js'], {
  OPENAI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
  // The mock accepts any key; a real key in .env is never sent anywhere during a rehearsal.
  OPENAI_API_KEY: 'rehearsal-mock-key'
});
console.log('[rehearse] Mock OpenAI and backend starting. Run "npm run links" in another terminal for the console links.');
