import sharp from 'sharp';
import { classify, CURRENT_THRESHOLDS } from './threshold-tuning.js';

const MIN_DIMENSION = 256;
const MIN_MEAN_LUMINANCE = 35;
const MAX_MEAN_LUMINANCE = 235;
const MIN_CONTRAST = 12;

// Thresholds on CIELAB hue angle (degrees): redder skin reads cooler, yellower skin warmer. Shared with
// the sidecar via SKIN_COOL_MAX_HUE / SKIN_WARM_MIN_HUE; tune them with `npm run tune-thresholds`.

const MIN_SKIN_SAMPLES = 150;

export async function checkImageQuality(buffer) {
  let data;
  let info;
  let metadata;
  try {
    metadata = await sharp(buffer).metadata();
    ({ data, info } = await sharp(buffer)
      .rotate()
      .resize(256, 256, { fit: 'inside' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true }));
  } catch {
    return { usable: false, reason: 'Could not read the photo. Please try again.' };
  }

  const pixelCount = info.width * info.height;
  let sum = 0;
  let sumSquares = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const luminance = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    sum += luminance;
    sumSquares += luminance * luminance;
  }
  const meanLuminance = sum / pixelCount;
  const contrast = Math.sqrt(Math.max(0, sumSquares / pixelCount - meanLuminance * meanLuminance));
  const stats = {
    width: metadata.width,
    height: metadata.height,
    meanLuminance: Math.round(meanLuminance),
    contrast: Math.round(contrast)
  };

  if (Math.min(metadata.width || 0, metadata.height || 0) < MIN_DIMENSION) {
    return { usable: false, reason: 'Photo resolution is too low. Please step closer or retake.', stats };
  }
  if (meanLuminance < MIN_MEAN_LUMINANCE) {
    return { usable: false, reason: 'Photo is too dark. Please improve the lighting and retake.', stats };
  }
  if (meanLuminance > MAX_MEAN_LUMINANCE) {
    return { usable: false, reason: 'Photo is overexposed. Please reduce the glare and retake.', stats };
  }
  if (contrast < MIN_CONTRAST) {
    return { usable: false, reason: 'Photo looks blank. Please make sure the camera can see you.', stats };
  }
  return { usable: true, reason: '', stats };
}

export async function measureSkinTone(buffer, faceBox) {
  if (!isValidBox(faceBox)) {
    return null;
  }

  const { data, info } = await sharp(buffer)
    .rotate()
    .resize(1024, 1024, { fit: 'inside' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const gains = grayWorldGains(data, info.channels);

  // Sample the inner part of the face box to stay clear of hair and background.
  const x0 = Math.floor((faceBox.x + faceBox.width * 0.2) * info.width);
  const x1 = Math.ceil((faceBox.x + faceBox.width * 0.8) * info.width);
  const y0 = Math.floor((faceBox.y + faceBox.height * 0.15) * info.height);
  const y1 = Math.ceil((faceBox.y + faceBox.height * 0.85) * info.height);

  const samples = { L: [], a: [], b: [] };
  for (let y = Math.max(0, y0); y < Math.min(info.height, y1); y += 1) {
    for (let x = Math.max(0, x0); x < Math.min(info.width, x1); x += 1) {
      const offset = (y * info.width + x) * info.channels;
      const r = Math.min(255, data[offset] * gains.r);
      const g = Math.min(255, data[offset + 1] * gains.g);
      const b = Math.min(255, data[offset + 2] * gains.b);
      if (!isSkinPixel(r, g, b)) {
        continue;
      }
      const lab = rgbToLab(r, g, b);
      samples.L.push(lab.L);
      samples.a.push(lab.a);
      samples.b.push(lab.b);
    }
  }

  const sampleCount = samples.L.length;
  if (sampleCount < MIN_SKIN_SAMPLES) {
    return null;
  }

  const L = median(samples.L);
  const a = median(samples.a);
  const b = median(samples.b);
  const ita = (Math.atan((L - 50) / Math.max(b, 0.001)) * 180) / Math.PI;
  const hueAngle = (Math.atan2(b, a) * 180) / Math.PI;
  const maxGainShift = Math.max(...Object.values(gains).map((gain) => Math.abs(gain - 1)));

  return {
    method: 'measured',
    skinUndertone: classify(hueAngle, CURRENT_THRESHOLDS()),
    skinDepth: ita > 55 ? 'fair' : ita > 41 ? 'light' : ita > 28 ? 'medium' : ita > 10 ? 'tan' : 'deep',
    lab: { L: round(L), a: round(a), b: round(b) },
    ita: round(ita),
    hueAngle: round(hueAngle),
    whiteBalanceGains: { r: round(gains.r, 3), g: round(gains.g, 3), b: round(gains.b, 3) },
    sampleCount,
    confidence: sampleCount >= 1500 && maxGainShift < 0.15 ? 'high' : sampleCount >= 400 ? 'medium' : 'low'
  };
}

function isValidBox(box) {
  return (
    box &&
    [box.x, box.y, box.width, box.height].every((value) => Number.isFinite(value)) &&
    box.width > 0.01 &&
    box.height > 0.01 &&
    box.x >= 0 &&
    box.y >= 0 &&
    box.x + box.width <= 1.001 &&
    box.y + box.height <= 1.001
  );
}

// Gray-world white balance: assume the scene averages to neutral grey and correct the colour cast.
function grayWorldGains(data, channels) {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += channels) {
    const luminance = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    if (luminance < 30 || luminance > 230) {
      continue;
    }
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    count += 1;
  }
  if (!count) {
    return { r: 1, g: 1, b: 1 };
  }

  const gray = (r + g + b) / (3 * count);
  const clamp = (gain) => Math.min(1.33, Math.max(0.75, gain));
  return { r: clamp((gray * count) / r), g: clamp((gray * count) / g), b: clamp((gray * count) / b) };
}

function isSkinPixel(r, g, b) {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  return y > 40 && y < 240 && cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173;
}

export function rgbToLab(r, g, b) {
  const linear = (channel) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const lr = linear(r);
  const lg = linear(g);
  const lb = linear(b);

  const x = (0.4124 * lr + 0.3576 * lg + 0.1805 * lb) / 0.95047;
  const y = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
  const z = (0.0193 * lr + 0.1192 * lg + 0.9505 * lb) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

  return { L: 116 * f(y) - 16, a: 500 * (f(x) - f(y)), b: 200 * (f(y) - f(z)) };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
