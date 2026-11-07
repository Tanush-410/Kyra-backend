import { bufferToDataUrl, fileTimestamp, normalizeString, normalizeScore } from './normalize.js';

export const FULL_BODY_FRAMING = [
  'Output requirements:',
  '- Portrait 9:16 image (1024x1536).',
  '- The entire person must be visible from head to feet (no cropping of head, legs, or shoes).',
  '- Subject must appear large in frame (roughly 88-94% of frame height).',
  '- Keep only tight safety margins above head and below feet; avoid large empty black space.',
  '- Plain solid black background only. No extra people, props, logos, or text.'
];

async function checkFacePreserved(openai, originalDataUrl, generatedDataUrl) {
  const parsed = await openai.respondJson({
    kind: 'face_check',
    text: [
      'Image 1 is the original photo. Image 2 is an AI-generated virtual try-on of the most prominent person in image 1.',
      'Judge only whether the face and identity were preserved: facial features, face shape, skin tone, hair, apparent age.',
      'Ignore clothing, pose, framing, lighting, and background.',
      'Return STRICT JSON only: { "samePerson": boolean, "score": number, "issues": string }',
      '- score: 0 to 1, where 1 means clearly the same person with no visible facial changes.',
      '- issues: short description of any facial changes, or "" if none.'
    ].join('\n'),
    images: [originalDataUrl, generatedDataUrl]
  });

  return {
    samePerson: Boolean(parsed?.samePerson),
    score: normalizeScore(parsed?.score, 1),
    issues: normalizeString(parsed?.issues).slice(0, 200)
  };
}

// Generates a try-on image and, when enabled, verifies the face against the original photo,
// regenerating up to `faceCheckRetries` times and keeping the best-scoring attempt.
export async function generateTryOn({ openai, config, prompt, images, originalDataUrl, log }) {
  let best = null;
  let attempts = 0;
  const maxAttempts = config.faceCheck ? 1 + Math.max(0, config.faceCheckRetries) : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;
    const base64 = await openai.editImage({ prompt, images });
    if (!config.faceCheck) {
      return { base64, faceCheck: { checked: false } };
    }

    let check;
    try {
      check = await checkFacePreserved(openai, originalDataUrl, bufferToDataUrl(Buffer.from(base64, 'base64')));
    } catch (error) {
      log?.warn({ error: error?.message }, 'Face check failed; returning unverified image');
      return { base64, faceCheck: { checked: false, error: 'Face check unavailable.' } };
    }

    const passed = check.samePerson && check.score >= config.faceCheckMinScore;
    if (!best || check.score > best.faceCheck.score) {
      best = { base64, faceCheck: { checked: true, passed, ...check } };
    }
    if (passed) {
      break;
    }
    log?.warn({ attempt, score: check.score, issues: check.issues }, 'Generated face drifted from original');
  }

  best.faceCheck.attempts = attempts;
  return best;
}

// Runs generation in the background and settles the job; never throws.
export function startTryOnJob({ openai, config, jobs, storage, log, jobId, prompt, images, originalDataUrl, filePrefix, result = {}, onFiles }) {
  generateTryOn({ openai, config, prompt, images, originalDataUrl, log })
    .then(({ base64, faceCheck }) => {
      const generatedFile = storage.saveBuffer('generated', `${filePrefix}-${fileTimestamp()}.png`, Buffer.from(base64, 'base64'));
      const job = jobs.complete(jobId, {
        artifacts: generatedFile ? { generatedFile } : {},
        result: {
          ...result,
          imageFile: generatedFile || '',
          imageDataUrl: `data:image/png;base64,${base64}`,
          faceCheck
        }
      });
      if (!job) {
        // The job timed out or its session was deleted meanwhile; do not leave the image behind.
        storage.deleteFiles([generatedFile].filter(Boolean));
        return;
      }
      onFiles?.([generatedFile, job.artifacts?.virtualTryOnFile].filter(Boolean));
    })
    .catch((error) => {
      log?.error({ jobId, error: error?.message || 'unknown generation failure' }, 'Virtual try-on generation failed');
      const job = jobs.fail(jobId, error?.message || 'Virtual try-on generation failed.');
      onFiles?.([job?.artifacts?.virtualTryOnFile].filter(Boolean));
    });
}
