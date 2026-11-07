import { CatalogueUnavailableError } from '../lib/catalogue.js';
import { fileTimestamp, normalizeCategory, normalizeGender, normalizeString } from '../lib/normalize.js';
import { FULL_BODY_FRAMING, startTryOnJob } from '../lib/tryon.js';
import { readPhoto } from './photo.js';

export default async function suggestionRoutes(app, { openai, config, storage, jobs, catalogue, rateLimit }) {
  app.post('/api/outfit-suggestion', { config: { rateLimit } }, async (request, reply) => {
    const gender = normalizeGender(request.body?.gender);
    if (!gender) {
      return reply.code(400).send({ error: 'gender must be "male" or "female".' });
    }

    const photo = await readPhoto(request.body?.imageDataUrl);
    if (photo.error) {
      return reply.code(photo.status).send(photo.error);
    }

    let outfit;
    try {
      outfit = catalogue.pickNonRepeating(gender);
    } catch (error) {
      if (error instanceof CatalogueUnavailableError) {
        request.log.error(error.message);
        return reply.code(503).send({ error: error.message });
      }
      throw error;
    }

    const collage = catalogue.collageDataUrl(outfit);
    const selectedItems = catalogue.itemsForUi(outfit, gender, collage);
    const outfitMetadata = buildOutfitMetadata(selectedItems);

    const timestamp = fileTimestamp();
    const artifacts = {
      captureFile: storage.saveBuffer('captures', `capture-${gender}-${timestamp}.jpg`, photo.buffer),
      suggestionFile: storage.saveJson('suggestions', `suggestion-${gender}-${timestamp}.json`, {
        createdAt: new Date().toISOString(),
        gender,
        outfitId: outfit.outfitId,
        summary: outfit.summary,
        reasoning: outfit.reasoning,
        selectedItems
      })
    };

    const job = jobs.create({ kind: 'catalogue', gender, outfitId: outfit.outfitId, outfitMetadata, artifacts });
    request.log.info({ jobId: job.jobId, gender, outfitId: outfit.outfitId }, 'Sent for virtual try-on backend');

    const metadataLines = Object.entries(outfitMetadata)
      .map(([slot, item]) => (item ? `- ${slot}: ${item.id || 'unknown-id'} (${item.name || 'unnamed item'})` : `- ${slot}: none`))
      .join('\n');

    startTryOnJob({
      openai,
      config,
      jobs,
      storage,
      log: request.log,
      jobId: job.jobId,
      originalDataUrl: photo.dataUrl,
      filePrefix: `generated-${gender}`,
      result: { outfitId: outfit.outfitId, outfitMetadata },
      images: [
        { dataUrl: photo.dataUrl, filename: 'user.jpg' },
        { dataUrl: collage, filename: 'selected-outfit.png' }
      ],
      prompt: [
        'Create a realistic virtual try-on output for the most prominent centered person only.',
        'Ignore all other people if present.',
        `Gender profile: ${gender}.`,
        `Outfit reference id: ${outfit.outfitId}.`,
        'Outfit metadata:',
        metadataLines || '- none',
        'Use only the provided outfit collage as the clothing reference.',
        'Preserve identity, facial structure, skin tone, pose, and body shape.',
        'Blend outfit naturally with realistic folds, fit, shadows, and occlusion.',
        ...FULL_BODY_FRAMING
      ].join('\n')
    });

    return reply.send({
      gender,
      selectedItems,
      suggestion: { summary: outfit.summary, reasoning: outfit.reasoning },
      outfitMetadata,
      artifacts,
      virtualTryOnJobId: job.jobId
    });
  });
}

function buildOutfitMetadata(selectedItems) {
  const metadata = {};
  for (const [slot, item] of Object.entries(selectedItems)) {
    metadata[slot] = item
      ? { id: normalizeString(item.id), category: normalizeCategory(item.category) || slot, name: normalizeString(item.name) }
      : null;
  }
  return metadata;
}
