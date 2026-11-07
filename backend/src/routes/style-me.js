import { measureSkinTone } from '../lib/image-analysis.js';
import { fileTimestamp, normalizeGender, normalizeHeight, normalizeHex, normalizePreferences, normalizeString, pickEnum, promptText, HEX_COLOR } from '../lib/normalize.js';
import { FULL_BODY_FRAMING, startTryOnJob } from '../lib/tryon.js';
import { readPhoto } from './photo.js';

const UNDERTONES = ['warm', 'cool', 'neutral'];
const DEPTHS = ['fair', 'light', 'medium', 'tan', 'deep'];
const HEIGHTS = ['petite', 'average', 'tall'];
const FRAMES = ['slim', 'medium', 'broad'];
const OUTFIT_CATEGORIES = new Set(['top', 'bottom', 'onepiece', 'outerwear', 'shoes', 'accessory']);

export default async function styleMeRoutes(app, { openai, config, storage, jobs, sessions, rateLimit }) {
  app.post('/api/style-me', { config: { rateLimit } }, async (request, reply) => {
    const body = request.body || {};
    const style = promptText(body.style, 120);
    const gender = normalizeGender(body.gender);
    const heightCm = normalizeHeight(body.heightCm);

    if (!style) {
      return reply.code(400).send({ error: 'style is required (for example "formal", "wedding guest", "casual").' });
    }
    if (body.gender !== undefined && body.gender !== '' && !gender) {
      return reply.code(400).send({ error: 'gender must be "male" or "female" when provided.' });
    }

    const photo = await readPhoto(body.imageDataUrl);
    if (photo.error) {
      return reply.code(photo.status).send(photo.error);
    }

    let assessment;
    try {
      assessment = await assessPhoto(openai, photo.dataUrl);
    } catch (error) {
      request.log.error({ error: error?.message }, 'Photo assessment failed');
      return reply.code(502).send({ error: 'Could not analyse the photo. Please try again.' });
    }

    const rejection = photoRejection(assessment, config);
    if (rejection) {
      return reply.code(422).send({ error: rejection, code: 'retake', assessment: publicAssessment(assessment) });
    }

    let measurement = null;
    try {
      measurement = await measureSkinTone(photo.buffer, assessment.faceBox);
    } catch (error) {
      request.log.warn({ error: error?.message }, 'Skin tone measurement failed; using visual estimate');
    }

    const session = sessions.create({
      imageDataUrl: photo.dataUrl,
      gender,
      heightCm,
      style,
      preferences: normalizePreferences(body.preferences),
      profile: buildProfile(assessment, measurement, heightCm),
      currentOutfit: assessment.currentOutfit
    });

    session.captureFile = storage.saveBuffer('captures', `styled-capture-${fileTimestamp()}.jpg`, photo.buffer);
    if (session.captureFile) {
      session.files.push(session.captureFile);
    }

    return designAndRender(request, reply, session);
  });

  app.post('/api/style-me/:sessionId/next', { config: { rateLimit } }, async (request, reply) => {
    const session = sessions.get(request.params.sessionId);
    if (!session) {
      return reply.code(404).send({ error: 'Style session not found or expired. Please take a new photo.' });
    }

    const body = request.body || {};
    const style = promptText(body.style, 120);
    if (style) {
      session.style = style;
    }
    if (body.preferences !== undefined) {
      session.preferences = { ...session.preferences, ...normalizePreferences(body.preferences, { partial: true }) };
    }

    return designAndRender(request, reply, session, promptText(body.feedback, 200));
  });

  app.delete('/api/style-me/:sessionId', async (request, reply) => {
    const session = sessions.delete(request.params.sessionId);
    if (!session) {
      return reply.code(404).send({ error: 'Style session not found or expired.' });
    }

    const files = [...session.files];
    for (const jobId of session.jobIds) {
      const job = jobs.remove(jobId);
      files.push(...Object.values(job?.artifacts || {}).filter((value) => typeof value === 'string'));
    }
    return reply.send({ deleted: true, filesDeleted: storage.deleteFiles(new Set(files)) });
  });

  async function designAndRender(request, reply, session, feedback = '') {
    let design;
    try {
      design = await designOutfit(openai, session, feedback);
    } catch (error) {
      request.log.error({ error: error?.message }, 'Outfit design failed');
      return reply.code(502).send({ error: 'Could not design an outfit. Please try again.' });
    }
    session.outfits.push({ style: session.style, summary: design.outfit.summary, feedback });

    const suggestionFile = storage.saveJson('suggestions', `styled-suggestion-${fileTimestamp()}.json`, {
      createdAt: new Date().toISOString(),
      sessionId: session.sessionId,
      style: session.style,
      gender: session.gender,
      heightCm: session.heightCm,
      preferences: session.preferences,
      feedback,
      profile: session.profile,
      ...design
    });
    if (suggestionFile) {
      session.files.push(suggestionFile);
    }

    const job = jobs.create({
      kind: 'style-me',
      sessionId: session.sessionId,
      gender: session.gender,
      style: session.style,
      outfitMetadata: design.outfit,
      artifacts: suggestionFile ? { suggestionFile } : {}
    });
    session.jobIds.push(job.jobId);

    startTryOnJob({
      openai,
      config,
      jobs,
      storage,
      log: request.log,
      jobId: job.jobId,
      originalDataUrl: session.imageDataUrl,
      filePrefix: 'generated-styled',
      result: { outfitMetadata: design.outfit },
      images: [{ dataUrl: session.imageDataUrl, filename: 'styled-user.jpg' }],
      prompt: buildTryOnPrompt(session.style, design.outfit.items),
      onFiles: (files) => session.files.push(...files)
    });

    return reply.send({
      sessionId: session.sessionId,
      style: session.style,
      preferences: session.preferences,
      profile: session.profile,
      palette: design.palette,
      outfit: design.outfit,
      optionNumber: session.outfits.length,
      artifacts: { captureFile: session.captureFile, suggestionFile },
      virtualTryOnJobId: job.jobId
    });
  }
}

async function assessPhoto(openai, imageDataUrl) {
  const parsed = await openai.respondJson({
    kind: 'photo_check',
    images: [imageDataUrl],
    text: [
      'You are the photo check for KYRA Smart Mirror, a virtual styling mirror.',
      'Decide whether this photo is usable for styling the most prominent person (centered, closest, or largest).',
      'Return STRICT JSON only (no markdown, no prose outside JSON):',
      '{',
      '  "usable": boolean,',
      '  "reason": string,',
      '  "personCount": number,',
      '  "singleProminentPerson": boolean,',
      '  "fullBodyVisible": boolean,',
      '  "faceVisible": boolean,',
      '  "lighting": "good" | "dim" | "harsh" | "uneven",',
      '  "faceBox": { "x": number, "y": number, "width": number, "height": number } | null,',
      '  "estimate": {',
      '    "skinUndertone": "warm" | "cool" | "neutral",',
      '    "skinDepth": "fair" | "light" | "medium" | "tan" | "deep",',
      '    "heightImpression": "petite" | "average" | "tall",',
      '    "frame": "slim" | "medium" | "broad"',
      '  },',
      '  "currentOutfit": string',
      '}',
      'Rules:',
      '- usable is false if there is no person, no single clearly prominent person, the face is hidden, or the photo is too dark, blurry, or cropped to style.',
      '- reason: when unusable, one short instruction the person can follow to retake (max 14 words); otherwise "".',
      '- fullBodyVisible: true only if head to feet are in frame.',
      '- faceBox: tight box around the prominent person\'s face (forehead to chin), as fractions 0-1 of image width/height from the top-left; null if not visible.',
      '- estimate: visual estimate used only to choose flattering colours and cuts. Never judge attractiveness, weight, age, or ethnicity.',
      '- currentOutfit: what they are wearing now, max 12 words, neutral description.'
    ].join('\n')
  });

  const box = parsed?.faceBox;
  return {
    usable: Boolean(parsed?.usable),
    reason: normalizeString(parsed?.reason).slice(0, 140),
    personCount: Number.isFinite(Number(parsed?.personCount)) ? Number(parsed.personCount) : 0,
    singleProminentPerson: Boolean(parsed?.singleProminentPerson),
    fullBodyVisible: Boolean(parsed?.fullBodyVisible),
    faceVisible: Boolean(parsed?.faceVisible),
    lighting: pickEnum(parsed?.lighting, ['good', 'dim', 'harsh', 'uneven']) || 'good',
    faceBox: box ? { x: Number(box.x), y: Number(box.y), width: Number(box.width), height: Number(box.height) } : null,
    estimate: {
      skinUndertone: pickEnum(parsed?.estimate?.skinUndertone, UNDERTONES),
      skinDepth: pickEnum(parsed?.estimate?.skinDepth, DEPTHS),
      heightImpression: pickEnum(parsed?.estimate?.heightImpression, HEIGHTS),
      frame: pickEnum(parsed?.estimate?.frame, FRAMES)
    },
    currentOutfit: normalizeString(parsed?.currentOutfit).slice(0, 120)
  };
}

function photoRejection(assessment, config) {
  if (assessment.personCount === 0) {
    return 'No person detected. Please stand in front of the mirror.';
  }
  if (!assessment.singleProminentPerson) {
    return assessment.reason || 'Several people are in frame. Please make sure only one person is in front.';
  }
  if (!assessment.faceVisible) {
    return assessment.reason || 'Your face is not visible. Please face the mirror.';
  }
  if (config.requireFullBody && !assessment.fullBodyVisible) {
    return 'Please step back so your whole body, head to feet, is in frame.';
  }
  if (!assessment.usable) {
    return assessment.reason || 'Photo is not clear enough. Please retake.';
  }
  return '';
}

function publicAssessment({ personCount, singleProminentPerson, fullBodyVisible, faceVisible, lighting }) {
  return { personCount, singleProminentPerson, fullBodyVisible, faceVisible, lighting };
}

function buildProfile(assessment, measurement, heightCm) {
  const useMeasurement = measurement && measurement.confidence !== 'low';
  return {
    skinUndertone: (useMeasurement && measurement.skinUndertone) || assessment.estimate.skinUndertone,
    skinDepth: (useMeasurement && measurement.skinDepth) || assessment.estimate.skinDepth,
    skinToneSource: useMeasurement ? 'measured' : 'estimated',
    skinMeasurement: measurement,
    visualEstimate: { skinUndertone: assessment.estimate.skinUndertone, skinDepth: assessment.estimate.skinDepth },
    heightImpression: heightCm ? heightFromCm(heightCm) : assessment.estimate.heightImpression,
    heightCm: heightCm || null,
    frame: assessment.estimate.frame,
    lighting: assessment.lighting
  };
}

function heightFromCm(heightCm) {
  return heightCm < 160 ? 'petite' : heightCm > 180 ? 'tall' : 'average';
}

async function designOutfit(openai, session, feedback) {
  const { profile, preferences, style, gender, heightCm } = session;
  const measured = profile.skinMeasurement;
  const avoid = preferences.avoidColors.length ? preferences.avoidColors.join(', ') : '';

  const parsed = await openai.respondJson({
    kind: 'design_v1',
    text: [
      'You are KYRA Smart Mirror\'s senior personal stylist.',
      `Design one complete outfit for this requested style: "${style}".`,
      'Styling profile:',
      `- Skin undertone: ${profile.skinUndertone || 'unknown'}; skin depth: ${profile.skinDepth || 'unknown'} (${profile.skinToneSource}).`,
      measured
        ? `- Measured skin colour (CIELAB, white-balanced): L*=${measured.lab.L}, a*=${measured.lab.a}, b*=${measured.lab.b}, hue angle ${measured.hueAngle} degrees.`
        : '- No pixel measurement available; skin values are a visual estimate.',
      heightCm ? `- Height: ${heightCm} cm (${profile.heightImpression}).` : `- Height impression: ${profile.heightImpression || 'unknown'}.`,
      `- Frame: ${profile.frame || 'unknown'}.`,
      gender
        ? `- Gender profile: ${gender}.`
        : `- Gender profile not given; design in line with their current outfit: ${session.currentOutfit || 'unknown'}.`,
      'Preferences:',
      preferences.season ? `- Season: ${preferences.season}.` : '- Season: any.',
      preferences.weather ? `- Weather: ${preferences.weather}.` : '',
      avoid ? `- Never use these colours: ${avoid}.` : '',
      preferences.modesty !== 'standard' ? `- Coverage: ${preferences.modesty.replace('-', ' ')} (cover shoulders and knees at minimum).` : '',
      preferences.budget ? `- Budget level: ${preferences.budget}.` : '',
      session.outfits.length
        ? `Already suggested (do not repeat these; offer a clearly different option):\n${session.outfits.map((outfit) => `- [${outfit.style}] ${outfit.summary}`).join('\n')}`
        : '',
      feedback ? `The person's feedback on the last suggestion: "${feedback}". Act on it.` : '',
      'Design rules:',
      '- Choose colours that flatter the undertone and depth; give a hex code for each item.',
      '- Choose cuts and lengths that suit the height and frame.',
      '- Name real, specific garment types (for example "charcoal slim-fit wool blazer"), never vague items.',
      '- Include top and bottom (or a onepiece) and shoes; add outerwear/accessory only if the style calls for it.',
      'Never comment on attractiveness, weight, age, ethnicity, or identity.',
      'Return STRICT JSON only (no markdown, no prose outside JSON):',
      '{',
      '  "palette": [ { "name": string, "hex": string } ],',
      '  "outfit": {',
      '    "summary": string,',
      '    "reasoning": string,',
      '    "items": [ { "category": "top" | "bottom" | "onepiece" | "outerwear" | "shoes" | "accessory", "name": string, "color": string, "hex": string, "fit": string, "material": string } ]',
      '  }',
      '}',
      '- palette: 3 to 5 colours that suit this person.',
      '- outfit.summary: one sentence, maximum 14 words.',
      '- outfit.reasoning: maximum 2 sentences linking colours to undertone and cuts to height/frame.'
    ]
      .filter(Boolean)
      .join('\n')
  });

  const items = normalizeOutfitItems(parsed?.outfit?.items);
  if (!items.length) {
    throw new Error('Outfit design returned no items.');
  }

  return {
    palette: normalizePalette(parsed?.palette),
    outfit: {
      summary: normalizeString(parsed?.outfit?.summary),
      reasoning: normalizeString(parsed?.outfit?.reasoning),
      items
    }
  };
}

function buildTryOnPrompt(style, items) {
  const itemLines = items
    .map((item) => {
      const hex = HEX_COLOR.test(item.hex || '') ? ` (${item.hex})` : '';
      const details = [item.color && `${promptText(item.color, 40)}${hex}`, promptText(item.fit, 80), promptText(item.material, 80)]
        .filter(Boolean)
        .join(', ');
      return `- ${promptText(item.category, 20)}: ${promptText(item.name, 80)}${details ? ` — ${details}` : ''}`;
    })
    .join('\n');

  return [
    'Create a realistic virtual try-on output for the most prominent centered person only.',
    'Ignore all other people if present.',
    `Dress the person in this ${style} outfit, replacing what they currently wear:`,
    itemLines,
    'Match each garment\'s color, fit, and material exactly as described. Do not add unlisted garments.',
    'Preserve identity, face, facial structure, skin tone, hair, body shape, and apparent age exactly.',
    'Do not lighten, darken, or recolor the skin. Do not age-shift or beautify the face.',
    'Blend garments naturally with realistic fit, folds, shadows, and occlusion.',
    'Repose the user to a neutral front-facing standing pose with relaxed arms.',
    'Keep lighting on the person clean and even, with natural skin tones and correct white balance.',
    ...FULL_BODY_FRAMING
  ].join('\n');
}

function normalizePalette(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => ({ name: normalizeString(entry?.name).slice(0, 40), hex: normalizeHex(entry?.hex) }))
    .filter((entry) => entry.name && entry.hex)
    .slice(0, 5);
}

export function normalizeOutfitItems(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      const category = normalizeString(entry?.category).toLowerCase();
      const name = normalizeString(entry?.name).slice(0, 80);
      if (!OUTFIT_CATEGORIES.has(category) || !name) {
        return null;
      }
      return {
        category,
        name,
        color: normalizeString(entry?.color).slice(0, 40),
        hex: normalizeHex(entry?.hex),
        fit: normalizeString(entry?.fit).slice(0, 40),
        material: normalizeString(entry?.material).slice(0, 40)
      };
    })
    .filter(Boolean)
    .slice(0, 8);
}
