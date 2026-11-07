import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { filePathToDataUrl, normalizeCategory, normalizeString } from './normalize.js';

const CACHE_TTL_MS = 60_000;

export class CatalogueUnavailableError extends Error {}

// Predefined outfits from data/<gender>_outfits.json. Metadata is cached and refreshed when the JSON
// changes (or every minute, so restored wardrobe images are picked up); collage images are only
// read for the outfit that is actually selected.
export function createCatalogue({ catalogueDataDir, projectRoot, wardrobeDir }) {
  const cache = new Map();
  const rotation = new Map();

  function load(gender) {
    const filePath = path.join(catalogueDataDir, `${gender}_outfits.json`);
    const mtimeMs = existsSync(filePath) ? statSync(filePath).mtimeMs : 0;
    const cached = cache.get(gender);
    if (cached && cached.mtimeMs === mtimeMs && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
      return cached.outfits;
    }

    const raw = mtimeMs ? JSON.parse(readFileSync(filePath, 'utf8')) : [];
    const outfits = (Array.isArray(raw) ? raw : [])
      .map((entry, index) => normalizeOutfit(entry, index, gender))
      .filter(Boolean);
    cache.set(gender, { mtimeMs, loadedAt: Date.now(), outfits });
    return outfits;
  }

  function normalizeOutfit(entry, index, gender) {
    const outfitId = normalizeString(entry?.outfit_id) || `${gender}-outfit-${index + 1}`;
    const collagePath = normalizeString(entry?.collage_path);
    const items = Array.isArray(entry?.items) ? entry.items : [];
    if (!collagePath || !items.length) {
      return null;
    }

    const absoluteCollagePath = path.resolve(projectRoot, collagePath);
    if (!existsSync(absoluteCollagePath)) {
      return null;
    }

    const nameFor = (category) =>
      normalizeString(items.find((item) => normalizeCategory(item?.category) === category)?.article_name);
    const summaryParts = [nameFor('top'), nameFor('bottom'), nameFor('shoes')].filter(Boolean);

    return {
      outfitId,
      gender,
      collagePath,
      absoluteCollagePath,
      items,
      summary: summaryParts.length >= 2 ? `Try ${summaryParts.join(' + ')}.` : 'Outfit suggestion is ready.',
      reasoning: `Predefined outfit ${outfitId} selected for this session.`
    };
  }

  function pickNonRepeating(gender) {
    const outfits = load(gender);
    if (!outfits.length) {
      throw new CatalogueUnavailableError(
        `No predefined outfits available for ${gender}: collage images were not found under ${path.join(wardrobeDir, 'outfits')}.`
      );
    }

    const ids = outfits.map((outfit) => outfit.outfitId);
    let queue = (rotation.get(gender) || []).filter((id) => ids.includes(id));
    if (!queue.length) {
      queue = shuffle(ids);
    }
    const nextId = queue.shift();
    rotation.set(gender, queue);
    return outfits.find((outfit) => outfit.outfitId === nextId) || outfits[0];
  }

  function collageDataUrl(outfit) {
    return filePathToDataUrl(outfit.absoluteCollagePath);
  }

  function itemsForUi(outfit, gender, collage) {
    const selected = { top: null, bottom: null, outerwear: null, shoes: null, accessory: null };
    const genderFolder = gender === 'male' ? 'Male' : 'Female';

    for (const rawItem of outfit.items) {
      const category = normalizeCategory(rawItem?.category);
      if (!category || selected[category]) {
        continue;
      }

      const imageId = normalizeString(rawItem?.image_id);
      const imageUrl = imageId ? filePathToDataUrl(path.join(wardrobeDir, genderFolder, `${imageId}.png`)) : collage;
      if (!imageUrl) {
        continue;
      }

      selected[category] = {
        id: imageId || `${category}-${outfit.outfitId}`,
        category,
        name: normalizeString(rawItem?.article_name) || normalizeString(rawItem?.type) || category,
        imageUrl
      };
    }
    return selected;
  }

  return { load, pickNonRepeating, collageDataUrl, itemsForUi };
}

function shuffle(ids) {
  const copy = [...ids];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
