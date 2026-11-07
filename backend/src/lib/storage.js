import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const STORAGE_DIRS = {
  lookImages: 'images',
  lookSuggestions: 'suggestions',
  captures: 'outfit-flow/captures',
  suggestions: 'outfit-flow/suggestions',
  generated: 'outfit-flow/generated',
  jobs: 'outfit-flow/virtual-tryon'
};

// Visitor photos are personal data: everything written here is deleted after `retentionHours`,
// and retentionHours <= 0 turns persistence off entirely.
export function createStorage({ artifactsDir, retentionHours }) {
  const enabled = retentionHours > 0;
  const retentionMs = retentionHours * 3_600_000;

  function write(dirKey, fileName, contents, encoding) {
    if (!enabled) {
      return null;
    }
    const directory = path.join(artifactsDir, STORAGE_DIRS[dirKey]);
    mkdirSync(directory, { recursive: true });
    const absolutePath = path.join(directory, fileName);
    writeFileSync(absolutePath, contents, encoding);
    return path.relative(artifactsDir, absolutePath);
  }

  function resolveInside(relativePath) {
    const absolutePath = path.resolve(artifactsDir, String(relativePath || ''));
    return absolutePath.startsWith(artifactsDir + path.sep) ? absolutePath : null;
  }

  return {
    enabled,
    root: artifactsDir,

    saveBuffer(dirKey, fileName, buffer) {
      return write(dirKey, fileName, buffer);
    },

    saveJson(dirKey, fileName, value) {
      return write(dirKey, fileName, JSON.stringify(value, null, 2), 'utf8');
    },

    saveText(dirKey, fileName, text) {
      return write(dirKey, fileName, text, 'utf8');
    },

    readJson(dirKey, fileName) {
      const absolutePath = path.join(artifactsDir, STORAGE_DIRS[dirKey], fileName);
      if (!enabled || !existsSync(absolutePath)) {
        return null;
      }
      try {
        return JSON.parse(readFileSync(absolutePath, 'utf8'));
      } catch {
        return null;
      }
    },

    readBuffer(relativePath) {
      const absolutePath = resolveInside(relativePath);
      return absolutePath && existsSync(absolutePath) ? readFileSync(absolutePath) : null;
    },

    deleteFiles(relativePaths) {
      let deleted = 0;
      for (const relativePath of relativePaths) {
        const absolutePath = resolveInside(relativePath);
        if (absolutePath && existsSync(absolutePath)) {
          rmSync(absolutePath, { force: true });
          deleted += 1;
        }
      }
      return deleted;
    },

    sweepExpired(now = Date.now()) {
      if (!enabled) {
        return 0;
      }
      let deleted = 0;
      for (const relativeDir of Object.values(STORAGE_DIRS)) {
        const directory = path.join(artifactsDir, relativeDir);
        if (!existsSync(directory)) {
          continue;
        }
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          if (!entry.isFile()) {
            continue;
          }
          const filePath = path.join(directory, entry.name);
          if (now - statSync(filePath).mtimeMs > retentionMs) {
            rmSync(filePath, { force: true });
            deleted += 1;
          }
        }
      }
      return deleted;
    }
  };
}
