import { fileTimestamp } from '../lib/normalize.js';
import { FULL_BODY_FRAMING, generateTryOn } from '../lib/tryon.js';
import { readPhoto } from './photo.js';

const HANDHELD_PROMPT = [
  'Create a realistic virtual try-on output for the most prominent centered person only.',
  'The user is holding a clothing item in the image.',
  'Use that held clothing item as the exact garment reference and make the same user wear it.',
  'Match the garment faithfully:',
  '- Keep the same garment category, silhouette, fit intent, neckline, sleeve length, and hem length.',
  '- Preserve key visual details: color, fabric texture, pattern, logos/graphics placement, and trims.',
  '- Do not invent extra garments or accessories that are not visible in the reference.',
  'Preserve identity, face, body shape, skin tone, and apparent age exactly.',
  'Do not make the person look older or younger.',
  'Do not add wrinkles, skin texture aging, gray hair, receding hairline, or age-shift effects.',
  'Repose the user to a neutral front-facing standing pose with relaxed arms.',
  'Lighting and realism requirements:',
  '- Keep lighting on the person clean and even, with natural skin tones and correct white balance.',
  '- Ensure face and clothing are well-lit and clearly visible (no harsh shadows, blown highlights, or underexposure).',
  '- Keep shadows soft and physically consistent with body shape and garment folds.',
  '- Avoid dramatic studio effects, colored lighting casts, or cinematic filters.',
  ...FULL_BODY_FRAMING
].join('\n');

export default async function handheldRoutes(app, { openai, config, storage, rateLimit }) {
  app.post('/api/handheld-virtual-tryon', { config: { rateLimit } }, async (request, reply) => {
    const photo = await readPhoto(request.body?.imageDataUrl);
    if (photo.error) {
      return reply.code(photo.status).send(photo.error);
    }

    try {
      const { base64, faceCheck } = await generateTryOn({
        openai,
        config,
        prompt: HANDHELD_PROMPT,
        images: [{ dataUrl: photo.dataUrl, filename: 'handheld-user.jpg' }],
        originalDataUrl: photo.dataUrl,
        log: request.log
      });
      const imageFile = storage.saveBuffer('generated', `generated-handheld-${fileTimestamp()}.png`, Buffer.from(base64, 'base64'));
      return reply.send({ imageFile: imageFile || '', imageDataUrl: `data:image/png;base64,${base64}`, faceCheck });
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: error?.message || 'Handheld virtual try-on failed.' });
    }
  });
}
