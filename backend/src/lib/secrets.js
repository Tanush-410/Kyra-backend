import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Tokens are on by default. An empty API_TOKEN or OPERATOR_TOKEN is generated on first start and kept in
// RUNTIME_DIR/secrets.json (readable by this user only), so the kiosk and operators keep working after a
// restart. "off" disables a token on purpose (local development only).
export function ensureTokens(config, { file = path.join(config.runtimeDir, 'secrets.json'), generate = () => randomBytes(24).toString('base64url') } = {}) {
  const saved = existsSync(file) ? safeRead(file) : {};
  const generated = [];
  const resolve = (key, value) => {
    if (String(value).toLowerCase() === 'off') {
      return '';
    }
    if (value) {
      return value;
    }
    if (!saved[key]) {
      saved[key] = generate();
      generated.push(key);
    }
    return saved[key];
  };
  const apiToken = resolve('apiToken', config.apiToken);
  const operatorToken = resolve('operatorToken', config.operatorToken);
  if (generated.length) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  return { config: { ...config, apiToken, operatorToken }, generated, file };
}

function safeRead(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) || {};
  } catch {
    return {};
  }
}
