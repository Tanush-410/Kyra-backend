import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const FILE_PATTERN = /^kyra-(\d{4}-\d{2}-\d{2})\.log$/;

// A log destination for Fastify's logger: every line goes to stdout and to logs/kyra-YYYY-MM-DD.log.
// A new file starts each day, and files older than retentionDays are deleted.
export function createLogStream({ dir, retentionDays = 14, stdout = process.stdout, today = () => new Date().toISOString().slice(0, 10) }) {
  mkdirSync(dir, { recursive: true });
  let day = null;
  let file = null;

  function rotate() {
    day = today();
    file = path.join(dir, `kyra-${day}.log`);
    if (!(retentionDays > 0)) {
      return;
    }
    const cutoff = new Date(Date.parse(day) - retentionDays * 86_400_000).toISOString().slice(0, 10);
    for (const name of readdirSync(dir)) {
      const match = FILE_PATTERN.exec(name);
      if (match && match[1] < cutoff) {
        rmSync(path.join(dir, name), { force: true });
      }
    }
  }

  return {
    write(line) {
      stdout?.write(line);
      if (today() !== day) {
        rotate();
      }
      try {
        // Synchronous so the last lines before a crash are on disk.
        appendFileSync(file, line);
      } catch {
        // A full or read-only disk must not take the mirror down; stdout still has the line.
      }
    }
  };
}

// Request log entries without secrets: the API token passed as ?token= (event stream, preview) and the
// share tokens of kept looks (anyone with one can open a visitor's photo).
export function redactUrl(url) {
  return String(url)
    .replace(/([?&](?:token|apiKey|api_key)=)[^&#]*/gi, '$1[redacted]')
    .replace(/\/looks\/[0-9a-f]{32}/gi, '/looks/[redacted]');
}

export const requestSerializer = (request) => ({
  method: request.method,
  url: redactUrl(request.url),
  host: request.host,
  remoteAddress: request.ip,
  remotePort: request.socket?.remotePort
});
