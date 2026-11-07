import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';

const TOKEN_PATTERN = /^[0-9a-f]{32}$/;

// "Take your look home": the only visitor data the mirror pipeline writes to disk, and only on request.
// A kept look is one PNG behind an unguessable link, deleted after keepHours.
export function createLookStore({ dir, keepHours, publicBaseUrl }) {
  const keepMs = keepHours * 3_600_000;

  const fileFor = (token) => path.join(dir, `${token}.png`);
  const metaFor = (token) => path.join(dir, `${token}.json`);

  return {
    enabled: keepHours > 0,

    async keep(imageBuffer) {
      if (!(keepHours > 0)) {
        throw new Error('Keeping looks is disabled (KEEP_HOURS=0).');
      }
      mkdirSync(dir, { recursive: true });
      const token = randomBytes(16).toString('hex');
      const expiresAt = new Date(Date.now() + keepMs).toISOString();
      writeFileSync(fileFor(token), imageBuffer);
      writeFileSync(metaFor(token), JSON.stringify({ token, expiresAt }));
      const url = `${publicBaseUrl.replace(/\/$/, '')}/looks/${token}`;
      return { token, url, expiresAt, qrDataUrl: await QRCode.toDataURL(url, { margin: 1, width: 320 }) };
    },

    get(token) {
      if (!TOKEN_PATTERN.test(String(token || '')) || !existsSync(metaFor(token))) {
        return null;
      }
      const meta = JSON.parse(readFileSync(metaFor(token), 'utf8'));
      if (Date.parse(meta.expiresAt) < Date.now()) {
        this.delete(token);
        return null;
      }
      return { ...meta, image: readFileSync(fileFor(token)) };
    },

    delete(token) {
      rmSync(fileFor(token), { force: true });
      rmSync(metaFor(token), { force: true });
    },

    sweep() {
      if (!existsSync(dir)) {
        return 0;
      }
      let deleted = 0;
      for (const name of readdirSync(dir).filter((file) => file.endsWith('.json'))) {
        const token = name.slice(0, -5);
        try {
          const meta = JSON.parse(readFileSync(metaFor(token), 'utf8'));
          if (Date.parse(meta.expiresAt) >= Date.now()) {
            continue;
          }
        } catch {
          // unreadable metadata: treat as expired
        }
        this.delete(token);
        deleted += 1;
      }
      return deleted;
    }
  };
}
