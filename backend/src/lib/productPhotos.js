import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Product photos for the kiosk's Suggestions and cart (Figma "Suggestion to buy"): a studio photo of each
// designed piece on its own, no person. The designer's text ("Olive cotton crew tee") is all that goes to
// OpenAI, never a visitor's photo or words. Each piece is drawn once and kept: the same piece (category,
// name, colour, material, fit, for women's or men's wear) reuses the same file for every later visitor.
//
// ensure(items, gender) -> [{ key, ready }] and starts the missing ones; when one is done the event hub
// gets { type: 'product.photo', key } (or failed: true), and GET /product-photos/<key>.png serves it.

const KEY = /^[a-f0-9]{24}$/;
const CONCURRENCY = 2;

const clean = (text, max = 60) => String(text || '').replace(/[^\p{L}\p{N} &'(),./-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

export function photoKey(item, gender = null) {
  const parts = [item.category, item.name, item.colorName, item.hex, item.material, item.fit, gender || ''].map((value) => clean(value).toLowerCase());
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24);
}

const WHAT = {
  top: 'top',
  bottom: 'bottoms',
  onepiece: 'one-piece garment',
  outerwear: 'outer layer',
  shoes: 'pair of shoes',
  accessory: 'accessory'
};

export function photoPrompt(item, gender = null) {
  const wear = gender === 'female' ? "women's " : gender === 'male' ? "men's " : '';
  const material = clean(item.material, 40);
  const fit = clean(item.fit, 30);
  const details = [material && `in ${material}`, fit && `${fit} fit`].filter(Boolean).join(', ');
  return [
    `E-commerce product photo of a single ${wear}${clean(item.name)} (${WHAT[item.category] || 'fashion item'}),`,
    `colour ${clean(item.colorName, 30)} (${/^#[0-9a-f]{6}$/i.test(item.hex || '') ? item.hex : 'as named'})${details ? `, ${details}` : ''}.`,
    'The item alone, shown whole and centred with empty space on every side (nothing cut off at the edges), front view, as if laid flat or on an invisible mannequin.',
    'No person, no body parts, no hanger, no text, no logo, no props.',
    'Transparent background, soft even studio light, realistic fabric texture, sharp focus.'
  ].join(' ');
}

export function createProductPhotos({ dir, openai, events, log, quality = 'low', enabled = true }) {
  const pending = new Map(); // key -> promise
  const queue = [];
  let running = 0;

  const fileFor = (key) => path.join(dir, `${key}.png`);
  const has = (key) => KEY.test(key) && existsSync(fileFor(key));

  const pump = () => {
    while (running < CONCURRENCY && queue.length) {
      const job = queue.shift();
      running += 1;
      job().finally(() => {
        running -= 1;
        pump();
      });
    }
  };

  function start(key, item, gender) {
    if (pending.has(key)) return pending.get(key);
    const promise = new Promise((resolve) => {
      queue.push(async () => {
        try {
          const base64 = await openai.generateImage({ prompt: photoPrompt(item, gender), quality, size: '1024x1024', background: 'transparent', budgetKind: 'photo', usageKind: 'product_photo' });
          mkdirSync(dir, { recursive: true });
          const tmp = `${fileFor(key)}.${process.pid}.tmp`;
          writeFileSync(tmp, Buffer.from(base64, 'base64'));
          renameSync(tmp, fileFor(key)); // never serve half a file
          events?.publish({ type: 'product.photo', key });
          resolve(true);
        } catch (error) {
          log?.warn({ error: error.message, key }, 'Product photo failed');
          events?.publish({ type: 'product.photo', key, failed: true });
          resolve(false);
        } finally {
          pending.delete(key);
        }
      });
      pump();
    });
    pending.set(key, promise);
    return promise;
  }

  return {
    enabled: Boolean(enabled && openai?.isConfigured),
    /** [{ key, ready }] for these items, in order; starts making the missing ones (when allowed). */
    ensure(items, gender = null, { allowNew = true } = {}) {
      return items.map((item) => {
        // A hairstyle isn't a product: the kiosk shows its own illustration.
        if (item.category === 'hair') return { key: null, ready: false, pending: false };
        const key = photoKey(item, gender);
        const ready = has(key);
        if (!ready && allowNew && this.enabled) start(key, item, gender);
        return { key, ready, pending: !ready && pending.has(key) };
      });
    },
    read(key) {
      return has(key) ? readFileSync(fileFor(key)) : null;
    },
    /** Resolves when the photos being made now are done (tests, shutdown). */
    idle: () => Promise.all([...pending.values()]),
  };
}
