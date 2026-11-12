import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';

// Serves the built kiosk UI (Kyra-UI-V1/dist) from this backend: one origin, so no CORS, no second web
// server, and the camera preview can be drawn to a canvas (hand tracking reads it) without tainting it.
// The UI has no secrets: the kiosk token reaches it in the link's #token, which browsers never send.

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream', // MediaPipe models
  '.txt': 'text/plain; charset=utf-8'
};

// MediaPipe compiles its WebAssembly ('wasm-unsafe-eval'); the Lexend font comes from Google Fonts; the
// render images and QR codes are data: URLs; the camera preview becomes a canvas stream (blob:/mediastream:).
export const FRONTEND_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data: blob:",
  "media-src 'self' blob: mediastream:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ');

// Vite's content-hashed build output ("index-B2x9KfQa.js") never changes, so browsers may keep it.
const HASHED = /-[A-Za-z0-9_-]{8,}\.(js|css|woff2?)$/;

// basePath: "/Kyra-UI-V1/". dir: the build folder.
export function registerFrontend(app, { dir, basePath }) {
  const base = `/${basePath.replace(/^\/+|\/+$/g, '')}/`;
  const root = path.resolve(dir);
  const index = path.join(root, 'index.html');

  const send = (reply, file) => {
    const ext = path.extname(file).toLowerCase();
    const cache = ext === '.html' ? 'no-cache' : HASHED.test(file) ? 'public, max-age=31536000, immutable' : 'public, max-age=3600';
    reply.type(TYPES[ext] || 'application/octet-stream').header('cache-control', cache).header('content-length', statSync(file).size);
    if (ext === '.html') {
      reply.header('content-security-policy', FRONTEND_POLICY);
    }
    return reply.send(createReadStream(file));
  };

  const serve = async (request, reply) => {
    if (!existsSync(index)) {
      return reply
        .code(404)
        .type('text/plain; charset=utf-8')
        .send(`The kiosk UI is not built yet. Run:\n\n  cd Kyra-UI-V1 && npm ci && npm run build\n\nthen reload. (Looked in ${root})`);
    }
    let relative;
    try {
      relative = decodeURIComponent(String(request.params['*'] || ''));
    } catch {
      return reply.code(400).type('text/plain').send('Bad path.');
    }
    // "//assets/x.png" (a doubled slash in a link) is the same file as "/assets/x.png".
    const file = path.resolve(root, `.${path.sep}${relative.replace(/^[\\/]+/, '')}`);
    if (file !== root && !file.startsWith(root + path.sep)) {
      return reply.code(404).type('text/plain').send('Not found.');
    }
    if (relative.split(/[\\/]/).some((part) => part.startsWith('.'))) {
      return reply.code(404).type('text/plain').send('Not found.');
    }
    if (existsSync(file) && statSync(file).isFile()) {
      return send(reply, file);
    }
    // Screens are client-side routes ("/Kyra-UI-V1/welcome"): they all load index.html. A missing file
    // with an extension is a real 404, so a broken asset link fails loudly instead of returning HTML.
    if (path.extname(relative)) {
      return reply.code(404).type('text/plain').send('Not found.');
    }
    return send(reply, index);
  };

  app.get(base.slice(0, -1), async (request, reply) => reply.redirect(base));
  app.get(`${base}*`, serve);
  return base;
}
