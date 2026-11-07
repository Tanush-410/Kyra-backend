import sharp from 'sharp';
import { dataUrlToBuffer } from './normalize.js';

async function rawGrey(buffer, width, height) {
  return sharp(buffer).resize(width, height, { fit: 'fill' }).greyscale().extractChannel(0).raw().toBuffer();
}

// RGBA PNG of the image with the given alpha. Each step is its own pipeline because sharp reorders
// operations inside one: removeAlpha() and flatten() would run around joinChannel() and lose the alpha.
async function withAlpha(image, alpha, width, height) {
  const rgb = await sharp(image).resize(width, height, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  return sharp(rgb, { raw: { width, height, channels: 3 } }).joinChannel(alpha, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

// Pastes the original head (face, hair, skin tone) back over the render through a soft keep-mask,
// so identity is pixel-exact wherever the render stayed aligned with the capture.
export async function pasteOriginalHead({ generated, originalDataUrl, keepMaskDataUrl }) {
  const { width, height } = await sharp(generated).metadata();
  const original = dataUrlToBuffer(originalDataUrl)?.buffer;
  const keep = dataUrlToBuffer(keepMaskDataUrl)?.buffer;
  if (!original || !keep) {
    return generated;
  }

  const head = await withAlpha(original, await rawGrey(keep, width, height), width, height);
  return sharp(generated).removeAlpha().composite([{ input: head }]).png().toBuffer();
}

// Everything outside the person mask becomes pure black, which a two-way mirror shows as glass.
export async function blackBackground(image, personMaskDataUrl) {
  const mask = dataUrlToBuffer(personMaskDataUrl)?.buffer;
  if (!mask) {
    return image;
  }
  const { width, height } = await sharp(image).metadata();
  // blur() returns three channels even for one-channel input, so take one back out.
  const alpha = await sharp(await rawGrey(mask, width, height), { raw: { width, height, channels: 1 } })
    .blur(1.2)
    .extractChannel(0)
    .raw()
    .toBuffer();
  return sharp(await withAlpha(image, alpha, width, height)).flatten({ background: '#000000' }).png().toBuffer();
}
