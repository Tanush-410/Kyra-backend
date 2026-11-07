import { checkImageQuality } from '../lib/image-analysis.js';
import { dataUrlToBuffer, isImageDataUrl } from '../lib/normalize.js';

// Validates an uploaded photo and runs the free local quality check, so black, blank or
// unreadable frames are rejected before any paid OpenAI call.
export async function readPhoto(imageDataUrl) {
  if (!isImageDataUrl(imageDataUrl)) {
    return { status: 400, error: { error: 'A valid imageDataUrl is required.' } };
  }

  const { mime, buffer } = dataUrlToBuffer(imageDataUrl) || {};
  if (!buffer?.length) {
    return { status: 400, error: { error: 'A valid imageDataUrl is required.' } };
  }

  const quality = await checkImageQuality(buffer);
  if (!quality.usable) {
    return { status: 422, error: { error: quality.reason, code: 'retake', quality: quality.stats || null } };
  }

  return { dataUrl: imageDataUrl, mime, buffer, quality: quality.stats };
}
