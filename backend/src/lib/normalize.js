import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Text that goes into a prompt (visitor input, or model-written item names passed on to the image model):
// one line of words, numbers and ordinary punctuation. Newlines, control and invisible characters, quotes,
// colons, brackets and markup are removed, so the text cannot open a new instruction or close the quotes
// around it. It reads the same for genuine input like "black-tie wedding, 50's style".
export function promptText(value, max = 120) {
  return normalizeString(value)
    .normalize('NFKC')
    .replace(/[\p{C}\u2028\u2029]/gu, ' ')
    .replace(/[^\p{L}\p{M}\p{N} .,'&()/%+-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

export const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function normalizeGender(value) {
  const raw = normalizeString(value).toLowerCase();
  return raw === 'male' || raw === 'female' ? raw : '';
}

export function normalizeScore(value, max = 10) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.min(max, Math.max(0, Math.round(numeric * 10) / 10));
}

export function normalizeHex(value) {
  const raw = normalizeString(value);
  return /^#[0-9a-fA-F]{6}$/.test(raw) ? raw.toUpperCase() : '';
}

export function pickEnum(value, allowed) {
  const raw = normalizeString(value).toLowerCase();
  return allowed.includes(raw) ? raw : '';
}

export function normalizeCategory(value) {
  const raw = normalizeString(value).toLowerCase();
  if (raw === 'top' || raw === 'bottom' || raw === 'outerwear') {
    return raw;
  }
  if (raw === 'footwear' || raw === 'shoes') {
    return 'shoes';
  }
  if (raw === 'accessory' || raw === 'accessories' || raw === 'jewelry' || raw === 'bag') {
    return 'accessory';
  }
  return '';
}

export function isImageDataUrl(value) {
  return typeof value === 'string' && /^data:image\/[a-z+.-]+;base64,/i.test(value);
}

export function dataUrlToBuffer(dataUrl) {
  const match = typeof dataUrl === 'string' ? dataUrl.match(/^data:([^;]+);base64,(.+)$/) : null;
  if (!match) {
    return null;
  }
  return { mime: match[1], buffer: Buffer.from(match[2], 'base64') };
}

export function bufferToDataUrl(buffer, mime = 'image/png') {
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

export function filePathToDataUrl(fullPath) {
  if (!existsSync(fullPath)) {
    return '';
  }

  const extension = path.extname(fullPath).toLowerCase();
  const mime =
    extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : extension === '.webp' ? 'image/webp' : 'image/png';
  return bufferToDataUrl(readFileSync(fullPath), mime);
}

export function stripCodeFence(text) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed.startsWith('```')) {
    return trimmed;
  }
  return trimmed.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim();
}

export function parseJsonOutput(text) {
  return JSON.parse(stripCodeFence(text));
}

export function fileTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

export function normalizeHeight(value) {
  const numeric = Number(value);
  return value !== null && value !== '' && Number.isFinite(numeric) && numeric >= 100 && numeric <= 230
    ? Math.round(numeric)
    : null;
}

export function normalizePreferences(value, { partial = false } = {}) {
  const raw = value && typeof value === 'object' ? value : {};
  const avoidSource = Array.isArray(raw.avoidColors) ? raw.avoidColors : String(raw.avoidColors || '').split(',');
  const season = pickEnum(raw.season === 'fall' ? 'autumn' : raw.season, ['spring', 'summer', 'autumn', 'winter']);

  const preferences = {
    season,
    weather: promptText(raw.weather, 60),
    avoidColors: avoidSource.map((color) => promptText(color, 30)).filter(Boolean).slice(0, 8),
    modesty: pickEnum(raw.modesty, ['standard', 'modest', 'very-modest']) || 'standard',
    budget: pickEnum(raw.budget, ['budget', 'mid-range', 'premium'])
  };

  if (!partial) {
    return preferences;
  }
  return Object.fromEntries(Object.entries(preferences).filter(([key]) => raw[key] !== undefined));
}
