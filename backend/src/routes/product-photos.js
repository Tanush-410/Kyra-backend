import { MirrorError } from '../lib/mirror.js';

// Product photos of the pieces in an outfit (lib/productPhotos.js).
//
// POST /api/v2/sessions/:sessionId/product-photos {round, option}
//   -> { enabled, photos: [{ index, key, ready, url }] } for that outfit's pieces, in order, and starts making
//   the missing ones; 'product.photo' events say when each is ready. The pieces come from the backend's own
//   design, so nothing the kiosk sends ends up in a prompt. No new photos in text-only mode or once the
//   day's budget is spent: the kiosk shows its own tiles then.
// GET /product-photos/<key>.png  the photo. Public like a kept look's page, but it shows only clothes.

const FILE = /^([a-f0-9]{24})\.png$/;

export default async function productPhotoRoutes(app, { productPhotos, mirror, budget, rateLimit }) {
  app.post('/api/v2/sessions/:sessionId/product-photos', { config: { rateLimit } }, async (request, reply) => {
    const round = Number(request.body?.round) || 1;
    const optionNumber = Number(request.body?.option) || 1;
    let snapshot;
    try {
      snapshot = mirror.get(request.params.sessionId);
    } catch (error) {
      if (error instanceof MirrorError) {
        return reply.code(error.status).send({ error: error.message, ...(error.code ? { code: error.code } : {}) });
      }
      throw error;
    }
    const option = snapshot.rounds.find((r) => r.round === round)?.options.find((o) => o.option === optionNumber);
    if (!option) {
      return reply.code(404).send({ error: 'No such option.' });
    }
    const allowNew = !snapshot.degraded && budget.fractionUsed() < 1;
    const photos = productPhotos.ensure(option.items, snapshot.gender, { allowNew }).map((photo, index) => ({
      index,
      key: photo.key,
      ready: photo.ready,
      url: photo.ready && photo.key ? `/product-photos/${photo.key}.png` : null
    }));
    return { enabled: productPhotos.enabled && allowNew, photos };
  });

  app.get('/product-photos/:file', async (request, reply) => {
    const match = FILE.exec(String(request.params.file || ''));
    const image = match ? productPhotos.read(match[1]) : null;
    if (!image) {
      return reply.code(404).type('text/plain').send('Not found.');
    }
    return reply.type('image/png').header('cache-control', 'public, max-age=31536000, immutable').send(image);
  });
}
