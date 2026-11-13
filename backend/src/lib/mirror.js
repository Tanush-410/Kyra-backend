import { randomUUID } from 'node:crypto';
import { BudgetExceededError } from './budget.js';
import { blackBackground, pasteOriginalHead } from './compose.js';
import { checkImageQuality } from './image-analysis.js';
import { OpenAIError } from './openai.js';
import { SidecarError } from './sidecar.js';
import { bufferToDataUrl, dataUrlToBuffer, HEX_COLOR, promptText } from './normalize.js';
import { designOptions, enforceDesign, fallbackOptions } from './outfit-design.js';
import { buildPalette, fitGuidance, learnedHints, optionScore } from './palette.js';

const MAX_ALIGN_SHIFT = 0.03;
const ALIGN_SCALE_RANGE = [0.9, 1.1];
// Upload checks the visitor cannot fix by holding still; camera captures never reach this.
const UPLOAD_REJECT = new Set(['no_person', 'multiple_people', 'too_dark', 'face_hidden']);

export class MirrorError extends Error {
  constructor(message, status = 400, code = '') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function heightImpression(heightCm) {
  if (!heightCm) {
    return null;
  }
  return heightCm < 160 ? 'petite' : heightCm > 180 ? 'tall' : 'average';
}

// The mirror pipeline: sidecar capture → measured profile → rule-based palette → one design call
// for three options → masked render with the original head pasted back → events to the UI.
// Everything about a visitor lives in memory and is dropped when the session ends.
const GESTURE_ACTIONS = { thumb_up: 'like', thumb_down: 'next', victory: 'keep' };

// What visitors see when something fails. Details go to the logs, never to the screen.
export const VISITOR_MESSAGES = {
  budget: 'The mirror has reached today\'s image limit. Here are your outfit ideas.',
  imagesUnavailable: 'The picture service is busy right now, so here are your outfit ideas. Ask for this look again in a moment.',
  imageRefused: 'That look could not be pictured. Try another one.',
  camera: 'The camera is not responding. Please try again in a moment.',
  generic: 'Something went wrong. Please try again.'
};

export function createMirror({ config, openai, sidecar, events, metrics, limiter, looks, budget, insights, alerts = null, log }) {
  const sessions = new Map();
  let variantCounter = 0;
  let visitorPresent = true;
  // Running averages of real tokens per call kind, seeded from real calls on 6 Nov 2026, for budget checks.
  const tokenEstimates = { design: 900, draft: 1100, 'image:low': 1100, 'image:medium': 2750, 'image:high': 6000 };
  const learnTokens = (kind, tokens) => {
    tokenEstimates[kind] = Math.round(0.7 * (tokenEstimates[kind] ?? tokens) + 0.3 * tokens);
  };
  // Would adding this call keep the look under the per-look token budget? (0 = no budget)
  const fitsLookBudget = (lookTokens, kind) => !(config.lookTokenBudget > 0) || lookTokens + (tokenEstimates[kind] ?? 0) <= config.lookTokenBudget;

  // A/B test of the final image quality: visitors alternate between the configured qualities.
  function assignVariant() {
    const qualities = config.finalQualityExperiment;
    return { finalQuality: qualities.length ? qualities[variantCounter++ % qualities.length] : config.finalQuality };
  }

  const publish = (session, type, data = {}) => events.publish({ type, sessionId: session.sessionId, ...data });
  const setStatus = (session, status, message = '') => {
    session.status = status;
    session.lastActivity = Date.now();
    publish(session, 'session.status', { status, message });
  };

  function get(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      throw new MirrorError('Session not found or ended.', 404);
    }
    session.lastActivity = Date.now();
    return session;
  }

  async function start({ style, gender, heightCm, preferences, imageDataUrl, consent = false }) {
    const session = {
      sessionId: randomUUID(),
      createdAt: Date.now(),
      lastActivity: Date.now(),
      status: 'created',
      source: imageDataUrl ? 'upload' : 'camera',
      style,
      gender,
      heightCm,
      preferences,
      capture: null,
      profile: null,
      palette: null,
      fitLines: [],
      rounds: [],
      renders: new Map(),
      timings: {},
      degraded: null,
      consentAt: consent ? Date.now() : null,
      activeKey: null,
      variant: assignVariant(),
      speculative: null,
      earlyDesigns: 0,
      wastedDesignTokens: 0,
      dwellTimer: null,
      scores: null,
      hints: null
    };
    sessions.set(session.sessionId, session);
    metrics.count('sessions');

    if (imageDataUrl) {
      setStatus(session, 'analyzing', 'Analysing your photo…');
      await analyzeUpload(session, imageDataUrl);
    } else {
      for (const other of sessions.values()) {
        if (other !== session && other.status === 'waiting_for_capture') {
          end(other, 'replaced');
        }
      }
      try {
        await sidecar.arm(session.sessionId);
      } catch (error) {
        sessions.delete(session.sessionId);
        log.warn({ error: error.message }, 'Could not arm the camera');
        throw new MirrorError(VISITOR_MESSAGES.camera, 503, 'sidecar_unavailable');
      }
      setStatus(session, 'waiting_for_capture', 'Stand in front of the mirror');
    }
    return snapshot(session);
  }

  async function analyzeUpload(session, imageDataUrl) {
    const decoded = dataUrlToBuffer(imageDataUrl);
    const quality = decoded ? await checkImageQuality(decoded.buffer) : { usable: false, reason: 'A valid imageDataUrl is required.' };
    if (!quality.usable) {
      sessions.delete(session.sessionId);
      throw new MirrorError(quality.reason, 422, 'retake');
    }

    let bundle;
    try {
      bundle = await sidecar.analyze(imageDataUrl);
    } catch (error) {
      sessions.delete(session.sessionId);
      log.warn({ error: error.message }, 'Sidecar could not analyse the upload');
      throw new MirrorError(VISITOR_MESSAGES.camera, 503, 'sidecar_unavailable');
    }
    const state = bundle.guidance?.state;
    // The masked render keeps the captured pose, so a seated or cropped photo cannot be dressed in place.
    if (UPLOAD_REJECT.has(state) || (config.requireFullBody && (state === 'too_close' || state === 'not_standing'))) {
      sessions.delete(session.sessionId);
      throw new MirrorError(bundle.guidance.message, 422, 'retake');
    }
    processCapture(session, bundle).catch((error) => fail(session, error));
  }

  async function onCapture(sessionId, captureId) {
    const session = sessions.get(sessionId);
    let bundle;
    try {
      bundle = await sidecar.getCapture(captureId);
      await sidecar.deleteCapture(captureId).catch(() => {});
    } catch (error) {
      if (session) {
        fail(session, error);
      }
      return;
    }
    if (!session || session.status !== 'waiting_for_capture') {
      return;
    }
    processCapture(session, bundle).catch((error) => fail(session, error));
  }

  // The design-relevant profile from a sidecar profile (from a capture or an early profile).
  function profileFrom(session, measured) {
    const skin = measured?.skin;
    const usableSkin = skin && skin.confidence !== 'low' ? skin : null;
    const heightCm = session.heightCm || measured?.height?.cm || null;
    return {
      // An unsure reading (or none) falls back to neutral, the palette that suits the widest range, and says so.
      skinUndertone: usableSkin?.skinUndertone || 'neutral',
      skinUndertoneSource: usableSkin ? 'measured' : 'fallback',
      olive: Boolean(usableSkin?.warmCool?.olive),
      skinDepth: usableSkin?.skinDepth || null,
      skinMeasurement: skin || null,
      heightCm,
      heightSource: session.heightCm ? 'visitor' : measured?.height?.cm ? 'calibrated-camera' : 'none',
      heightImpression: heightImpression(heightCm),
      build: measured?.frame?.build || null
    };
  }

  // Two profiles that lead to the same design: same palette, same fit rules.
  const profileKey = (profile) => [profile.skinUndertone, profile.skinDepth, profile.heightImpression, profile.build].join('|');
  // Early designs are keyed on what decides the palette (undertone and depth group): height and build
  // readings jitter while the visitor moves, and redesigning for each jitter wasted design calls live.
  const skinKey = (profile) => {
    const palette = buildPalette(profile);
    return [palette.basis.undertone, palette.basis.depthGroup].join('|');
  };

  // Palette, fit rules and learned preferences for a profile.
  function designContext(session, profile) {
    const scores = insights?.colourScores(profile.skinUndertone, config.learnMinRatings) || null;
    return {
      profile,
      scores,
      hints: learnedHints(scores),
      palette: buildPalette(profile, session.preferences.avoidColors, scores),
      fitLines: fitGuidance(profile)
    };
  }

  const sessionContext = (session) => ({ profile: session.profile, scores: session.scores, hints: session.hints, palette: session.palette, fitLines: session.fitLines });

  function applyContext(session, context) {
    Object.assign(session, { profile: context.profile, scores: context.scores, hints: context.hints, palette: context.palette, fitLines: context.fitLines });
    publish(session, 'session.profile', {
      profile: session.profile,
      palette: session.palette.palette,
      neutrals: session.palette.neutrals,
      paletteBasis: session.palette.basis,
      fitGuidance: session.fitLines
    });
  }

  async function processCapture(session, bundle) {
    const started = Date.now();
    session.captureAt = started;
    session.capture = bundle;
    setStatus(session, 'designing', 'Designing your looks…');
    applyContext(session, designContext(session, profileFrom(session, bundle.profile)));

    // Outfits designed from the early profile are reused when the capture confirms the same profile.
    const early = session.speculative;
    session.speculative = null;
    if (early && early.key === skinKey(session.profile)) {
      metrics.count('early_design_hits');
      if (early.fullKey !== profileKey(session.profile)) {
        metrics.count('early_design_fit_drift'); // same palette, slightly different height/build reading
      }
      const round = goLive(session, early.round);
      await early.done;
      metrics.time('capture_to_options', Date.now() - started);
      render(session, round.round, 1); // no-op if going live already started it
      return;
    }
    if (early) {
      // The skin reading changed the palette. A second design call would take this look over the token
      // rule, so the early outfits keep their garments and are recoloured into the right palette, in code.
      metrics.count('early_design_recoloured');
      await early.done;
      const round = early.round;
      round.context = sessionContext(session);
      round.options = enforceDesign(round.options, session.palette.allowed, session.preferences.avoidColors);
      round.order = round.options.map((o) => o.option);
      round.recoloured = true;
      goLive(session, round);
      metrics.time('capture_to_options', Date.now() - started);
      render(session, round.round, 1);
      return;
    }

    await designRound(session, '');
    metrics.time('capture_to_options', Date.now() - started);
    render(session, session.rounds.length, 1); // no-op if streaming already started it
  }

  // The sidecar sends the profile while the visitor is still getting into position. The skin reading is
  // shown straight away (it needs only the face), and the outfits are designed now, unpublished, so they
  // are ready (or nearly) when the photo is taken.
  function onEarlyProfile(sessionId, measured) {
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'waiting_for_capture') {
      return;
    }
    const early = profileFrom(session, measured);
    publish(session, 'session.skin', {
      skinUndertone: early.skinUndertone,
      skinUndertoneSource: early.skinUndertoneSource,
      olive: early.olive,
      skinDepth: early.skinDepth,
      skinMeasurement: early.skinMeasurement,
      palette: buildPalette(early).palette
    });
    if (!config.earlyDesign) {
      return;
    }
    const context = designContext(session, early);
    const key = skinKey(context.profile);
    if (context.profile.skinUndertoneSource !== 'measured' || session.speculative?.key === key || session.earlyDesigns >= config.earlyDesignMax) {
      return;
    }
    // An early design is never repeated (a palette change is recoloured in code), so the first look
    // costs one design plus its image. Skip designing early only if even that would not fit the budget.
    const firstLook = session.wastedDesignTokens + tokenEstimates.design + tokenEstimates[`image:${session.variant?.finalQuality || config.finalQuality}`];
    if (config.lookTokenBudget > 0 && firstLook > config.lookTokenBudget) {
      metrics.count('early_designs_skipped_for_token_budget');
      return;
    }
    if (session.speculative) {
      session.speculative.round.discarded = true;
    }
    const round = newRound(session, '', context);
    session.earlyDesigns += 1;
    session.speculative = { key, fullKey: profileKey(context.profile), round, done: runDesign(session, round).catch(() => {}) };
    metrics.count('early_designs');
  }

  function newRound(session, feedback, context) {
    return {
      round: null,
      style: session.style,
      feedback,
      source: 'ai',
      options: [],
      order: [],
      live: false,
      done: false,
      context,
      startedAt: Date.now(),
      previous: session.rounds.flatMap((round) => round.options.map((option) => `[${round.style}] ${option.summary}`))
    };
  }

  // Publishes a round (and whatever options it already has) and starts rendering option 1.
  function goLive(session, round) {
    round.round = session.rounds.length + 1;
    round.live = true;
    session.rounds.push(round);
    for (const option of round.options) {
      publish(session, 'session.option', { round: round.round, option });
    }
    if (round.options[0] && session.capture) {
      metrics.time('capture_to_first_option', Date.now() - (session.captureAt || round.startedAt));
      render(session, round.round, 1);
    }
    if (round.done) {
      finishRound(session, round);
    }
    return round;
  }

  function finishRound(session, round) {
    if (session.status !== 'rendering') {
      setStatus(session, 'options_ready');
    }
    publish(session, 'session.options', { round: round.round, style: round.style, source: round.source, options: round.options, order: round.order });
    if (session.degraded) {
      publish(session, 'session.degraded', session.degraded);
    }
  }

  async function runDesign(session, round) {
    const { context } = round;
    let options;
    try {
      options = await designOptions({
        openai,
        // Tokens of a discarded early design count against the visitor's first look.
        onUsage: (call) => {
          learnTokens('design', call.totalTokens);
          if (round.discarded) {
            session.wastedDesignTokens += call.totalTokens;
          } else {
            round.designTokens = (round.designTokens || 0) + call.totalTokens;
          }
        },
        onOption: (option) => {
          round.options.push(option);
          if (!round.live) {
            return;
          }
          publish(session, 'session.option', { round: round.round, option });
          if (option.option === 1 && session.capture) {
            metrics.time('capture_to_first_option', Date.now() - (session.captureAt || round.startedAt));
            render(session, round.round, 1);
          }
        },
        request: {
          style: round.style,
          gender: session.gender,
          profile: context.profile,
          palette: context.palette,
          fitLines: context.fitLines,
          preferences: session.preferences,
          previous: round.previous,
          feedback: round.feedback,
          hints: context.hints
        }
      });
    } catch (error) {
      log.warn({ sessionId: session.sessionId, error: error.message }, 'AI design unavailable; using rule-based options');
      options = round.options.length
        ? round.options
        : fallbackOptions({ style: round.style, gender: session.gender, palette: context.palette, preferences: session.preferences });
      round.source = round.options.length ? 'ai' : 'fallback';
      if (error instanceof BudgetExceededError) {
        session.degraded = { mode: 'text-only', reason: 'budget', message: VISITOR_MESSAGES.budget };
      }
      metrics.count('design_fallbacks');
    }
    metrics.time('design', Date.now() - round.startedAt);

    round.options = options;
    // Option 1 may already be rendering; the rest follow in order of predicted appeal.
    round.order = [1, ...options.slice(1).sort((a, b) => optionScore(b, context.scores) - optionScore(a, context.scores)).map((o) => o.option)];
    round.done = true;
    if (round.live) {
      finishRound(session, round);
    }
    return round;
  }

  async function designRound(session, feedback) {
    const round = goLive(session, newRound(session, feedback, sessionContext(session)));
    await runDesign(session, round);
    return round;
  }

  // The option after this one in the round's appeal order (wrapping round).
  function nextOption(round, optionNumber) {
    const order = round.order.length ? round.order : round.options.map((o) => o.option);
    return order[(order.indexOf(optionNumber) + 1) % order.length];
  }

  function canPrefetch(session) {
    const affordable = !budget || budget.fractionUsed() < config.prefetchBudgetFraction;
    return sessions.has(session.sessionId) && !session.degraded && limiter.stats().waiting === 0 && affordable;
  }

  // auto/true: render the next option whenever a render finishes (auto only when idle and affordable).
  function maybePrefetch(session, roundNumber) {
    if (!['auto', 'true'].includes(config.prefetchOptions) || !sessions.has(session.sessionId) || session.degraded) {
      return;
    }
    if (config.prefetchOptions === 'auto' && !canPrefetch(session)) {
      return;
    }
    const round = session.rounds[roundNumber - 1];
    const next = round?.order.find((option) => !session.renders.has(`${roundNumber}.${option}`));
    if (next) {
      metrics.count('prefetches');
      render(session, roundNumber, next, { prefetch: true });
    }
  }

  // dwell: once the visitor has looked at this look for PREFETCH_DWELL_MS and is still there,
  // render the next one in the background so "show me another" is instant.
  function armDwell(session, roundNumber, optionNumber) {
    if (config.prefetchOptions !== 'dwell') {
      return;
    }
    clearTimeout(session.dwellTimer);
    const key = `${roundNumber}.${optionNumber}`;
    session.dwellTimer = setTimeout(() => {
      if (session.activeKey !== key || (session.source === 'camera' && !visitorPresent) || !canPrefetch(session)) {
        return;
      }
      const round = session.rounds[roundNumber - 1];
      const next = round && nextOption(round, optionNumber);
      if (next && next !== optionNumber && !session.renders.has(`${roundNumber}.${next}`)) {
        metrics.count('prefetches');
        render(session, roundNumber, next, { prefetch: true });
      }
    }, config.prefetchDwellMs);
    session.dwellTimer.unref?.();
  }

  // Short on purpose: prompt tokens count against the per-look budget.
  function renderPrompt(option, withFaceReference) {
    // Item text was written by the design model from visitor input: cleaned before the image model sees it.
    const lines = option.items.map((item) => {
      const [name, colour, fit, material] = [item.name, item.colorName, item.fit, item.material].map((text) => promptText(text, 80));
      const hex = HEX_COLOR.test(item.hex) ? ` ${item.hex}` : '';
      return `- ${promptText(item.category, 20)}: ${name}, ${colour}${hex}${fit ? `, ${fit}` : ''}${material ? `, ${material}` : ''}`;
    });
    return [
      config.renderMask ? 'Edit only the transparent mask area. Dress this person in:' : 'Dress this person in:',
      ...lines,
      withFaceReference ? 'Image 2 is a close-up of the same face: keep that identity exactly.' : '',
      'Keep pose, framing, body shape, face, hair and skin tone exactly. Realistic fit and folds; no logos or text; plain black background.'
    ]
      .filter(Boolean)
      .join('\n');
  }

  function render(session, roundNumber, optionNumber, { prefetch = false } = {}) {
    const round = session.rounds[roundNumber - 1];
    const option = round?.options[optionNumber - 1];
    if (!option) {
      throw new MirrorError('No such option.', 404);
    }
    const key = `${roundNumber}.${optionNumber}`;
    const existing = session.renders.get(key);
    if (existing && existing.status !== 'failed') {
      if (!prefetch) {
        // The visitor asked for a look that is already rendering or done in the background.
        existing.prefetch = false;
        session.activeKey = key;
        if (existing.status === 'done') {
          publish(session, 'session.render.done', { round: roundNumber, option: optionNumber, imageDataUrl: existing.imageDataUrl, faceCheck: existing.faceCheck });
          armDwell(session, roundNumber, optionNumber);
        }
      }
      return existing;
    }
    if (session.degraded?.reason === 'budget') {
      publish(session, 'session.degraded', session.degraded);
      return { status: 'skipped' };
    }

    const entry = { key, round: roundNumber, option: optionNumber, status: 'queued', faceCheck: null, imageDataUrl: null, prefetch };
    session.renders.set(key, entry);
    if (!prefetch) {
      session.activeKey = key;
    }
    const started = Date.now();

    limiter
      .run(
        () => runRender(session, entry, option),
        (position) => {
          if (position > 0) {
            publish(session, 'session.render.queued', { round: roundNumber, option: optionNumber, position, prefetch });
          }
        }
      )
      .then(() => {
        metrics.time(entry.prefetch ? 'render_prefetch' : 'render_total', Date.now() - started);
        if (session.degraded?.reason === 'images_unavailable' && entry.status === 'done') {
          // The image service is back: leave text-only mode.
          session.degraded = null;
          publish(session, 'session.recovered', { round: roundNumber, option: optionNumber });
        }
        maybePrefetch(session, roundNumber);
      })
      .catch((error) => {
        entry.status = 'failed';
        entry.error = friendly(error);
        metrics.count('render_failures');
        log.error({ sessionId: session.sessionId, key, error: error.message, status: error.status }, 'Render failed');
        if (error instanceof BudgetExceededError) {
          session.degraded = { mode: 'text-only', reason: 'budget', message: VISITOR_MESSAGES.budget };
          publish(session, 'session.degraded', session.degraded);
        } else if (error instanceof OpenAIError && !entry.prefetch && error.status !== 400) {
          // The outfits are already on screen as text; show them as the result instead of an error.
          // Unlike the budget, this is temporary: asking for a look again retries the image.
          session.degraded = { mode: 'text-only', reason: 'images_unavailable', message: VISITOR_MESSAGES.imagesUnavailable };
          publish(session, 'session.degraded', session.degraded);
          alerts?.count('render_failures', 'Image renders are failing', { threshold: 3, details: { status: error.status } });
        }
        publish(session, 'session.render.failed', { round: roundNumber, option: optionNumber, error: friendly(error), prefetch: entry.prefetch });
      });
    return entry;
  }

  async function runRender(session, entry, option) {
    if (!sessions.has(session.sessionId)) {
      return;
    }
    const render = session.capture.render;
    // The face is taken from the visit's clearest close-up after the render (sidecar facetransfer.py), so by
    // default the model gets no face image. RENDER_FACE_REFERENCE=true sends it (~190 tokens) for soft faces.
    const softFace = (render.upscale ?? 1) >= 1.4 || (render.faceSourcePx ?? Infinity) < 60;
    const faceReference = config.renderFaceReference && softFace && render.faceRefDataUrl ? render.faceRefDataUrl : null;
    const prompt = renderPrompt(option, Boolean(faceReference));
    const renderStarted = Date.now();
    const tag = { round: entry.round, option: entry.option };
    const visible = () => !entry.prefetch;
    let firstShown = false;
    const markFirst = () => {
      if (!firstShown) {
        firstShown = true;
        metrics.time('first_image', Date.now() - renderStarted);
      }
    };

    // Per-look tokens: the round's design (and any wasted early design) belongs to its first look.
    const round = session.rounds[entry.round - 1];
    round.firstRenderKey ||= entry.key;
    const paysForDesign = round.firstRenderKey === entry.key;
    entry.tokens = { image: 0 };
    const lookTokens = () => (paysForDesign ? (round.designTokens || 0) + session.wastedDesignTokens : 0) + entry.tokens.image;
    const countImage = (kind) => (call) => {
      entry.tokens.image += call.totalTokens;
      learnTokens(kind, call.totalTokens);
    };

    entry.status = 'rendering';
    if (visible()) {
      setStatus(session, 'rendering', 'Creating your look…');
    }
    publish(session, 'session.render.started', { ...tag, prefetch: entry.prefetch });

    const request = {
      prompt,
      images: [{ dataUrl: render.imageDataUrl, filename: 'visitor.jpg' }, ...(faceReference ? [{ dataUrl: faceReference, filename: 'face.jpg' }] : [])],
      mask: config.renderMask ? render.editMaskDataUrl : null
    };
    const finalQuality = session.variant?.finalQuality || config.finalQuality;
    const finalKind = `image:${finalQuality}`;
    const designEstimate = paysForDesign && !round.done ? tokenEstimates.design : 0;

    // Optional fast draft: only if draft + final still fit the look's token budget.
    if (config.renderDraft && !entry.prefetch && fitsLookBudget(lookTokens() + designEstimate + tokenEstimates[finalKind], 'draft')) {
      openai
        .editImage({ ...request, quality: config.draftQuality, budgetKind: 'draft', onUsage: countImage('draft') })
        .then(async (base64) => {
          if (entry.status === 'done' || !sessions.has(session.sessionId)) {
            return;
          }
          const draft = await finishImage(session, Buffer.from(base64, 'base64'));
          if (entry.status !== 'done') {
            markFirst();
            metrics.time('draft', Date.now() - renderStarted);
            publish(session, 'session.render.draft', { ...tag, imageDataUrl: bufferToDataUrl(draft.image), faceCheck: draft.faceCheck });
          }
        })
        .catch((error) => log.warn({ sessionId: session.sessionId, error: error.message }, 'Draft render skipped'));
    } else if (config.renderDraft && !entry.prefetch) {
      metrics.count('drafts_skipped_for_token_budget');
    }

    const attempts = 1 + (config.faceCheck ? config.renderRetries : 0);
    let best = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (attempt > 1 && !fitsLookBudget(lookTokens(), finalKind)) {
        metrics.count('retries_skipped_for_token_budget');
        log.info({ sessionId: session.sessionId, lookTokens: lookTokens() }, 'Face-check retry skipped: it would exceed the per-look token budget');
        break;
      }
      const generationStarted = Date.now();
      const generatedBase64 = await openai.editImage({
        ...request,
        quality: finalQuality,
        usageKind: finalKind,
        onUsage: countImage(finalKind),
        partialImages: entry.prefetch ? 0 : config.partialImages,
        onPartial: (base64, index) => {
          pasteOriginalHead({ generated: Buffer.from(base64, 'base64'), originalDataUrl: render.imageDataUrl, keepMaskDataUrl: render.keepMaskDataUrl })
            .then((preview) => {
              markFirst();
              publish(session, 'session.render.partial', { ...tag, index, imageDataUrl: bufferToDataUrl(preview) });
            })
            .catch(() => {});
        }
      });
      metrics.time('generation', Date.now() - generationStarted);
      if (!sessions.has(session.sessionId)) {
        return;
      }

      const postStarted = Date.now();
      const result = await finishImage(session, Buffer.from(generatedBase64, 'base64'));
      metrics.time('post_process', Date.now() - postStarted);
      result.faceCheck.attempts = attempt;
      if (!best || (result.faceCheck.similarity ?? 0) > (best.faceCheck.similarity ?? 0)) {
        best = result;
      }
      if (result.faceCheck.passed !== false) {
        break;
      }
      log.warn({ sessionId: session.sessionId, faceCheck: result.faceCheck }, 'Face check failed');
    }

    entry.status = 'done';
    entry.imageDataUrl = bufferToDataUrl(best.image);
    entry.faceCheck = { ...best.faceCheck, faceReference: Boolean(faceReference) };
    const total = lookTokens();
    entry.tokens = {
      design: total - entry.tokens.image,
      image: entry.tokens.image,
      total,
      original: config.originalTokensPerLook,
      underOriginal: total < config.originalTokensPerLook
    };
    metrics.time('tokens_per_look', total);
    if (!entry.tokens.underOriginal) {
      metrics.count('looks_over_original_tokens');
      log.warn({ sessionId: session.sessionId, tokens: entry.tokens }, 'Look used more tokens than the original pipeline');
    }
    markFirst();
    if (visible()) {
      setStatus(session, 'ready');
      armDwell(session, entry.round, entry.option);
    }
    publish(session, 'session.render.done', { ...tag, imageDataUrl: entry.imageDataUrl, faceCheck: entry.faceCheck, tokens: entry.tokens, prefetch: entry.prefetch });
  }

  // The sidecar lines the render up with the capture, pastes the real head and hands back, blacks
  // out the background and checks identity in one call. If that fails, a head-only paste runs here.
  async function finishImage(session, generated) {
    const render = session.capture.render;
    try {
      const result = await sidecar.compose({
        originalDataUrl: render.imageDataUrl,
        generatedDataUrl: bufferToDataUrl(generated),
        keepMaskDataUrl: render.keepMaskDataUrl,
        referenceFaceDataUrl: render.faceRefDataUrl || null,
        faceSourcePx: render.faceSourcePx ?? null,
        upscale: render.upscale ?? null
      });
      const checked = config.faceCheck && result.similarity !== null && result.similarity !== undefined;
      return {
        image: dataUrlToBuffer(result.imageDataUrl).buffer,
        faceCheck: {
          checked,
          method: 'sface-embedding',
          headPasted: result.headPasted,
          headDecision: result.headDecision || null,
          handsPasted: result.handsPasted || [],
          warp: result.warp || null,
          silhouette: result.silhouette || null,
          similarity: result.similarity ?? null,
          threshold: result.threshold,
          ...(checked ? { passed: result.samePerson } : {}),
          alignmentShift: result.alignment?.shift ?? null,
          clearFace: result.clearFace || null
        }
      };
    } catch (error) {
      log.warn({ sessionId: session.sessionId, error: error.message }, 'Sidecar compose failed; finishing locally');
      return finishLocally(session, generated);
    }
  }

  async function finishLocally(session, generated) {
    const render = session.capture.render;
    const generatedDataUrl = bufferToDataUrl(generated);
    let image = generated;
    let pasted = false;

    const alignment = await sidecar.compareFaces(render.imageDataUrl, generatedDataUrl).catch((error) => ({ error: error.message }));
    const aligned =
      alignment.faceFound &&
      alignment.shift <= MAX_ALIGN_SHIFT &&
      alignment.scaleRatio >= ALIGN_SCALE_RANGE[0] &&
      alignment.scaleRatio <= ALIGN_SCALE_RANGE[1];
    if (aligned) {
      image = await pasteOriginalHead({ generated, originalDataUrl: render.imageDataUrl, keepMaskDataUrl: render.keepMaskDataUrl });
      pasted = true;
    }

    const segmentation = await sidecar.segment(bufferToDataUrl(image)).catch(() => null);
    if (segmentation?.personFound) {
      image = await blackBackground(image, segmentation.maskDataUrl);
    }

    if (!config.faceCheck) {
      return { image, faceCheck: { checked: false, headPasted: pasted } };
    }
    const check = await sidecar.compareFaces(render.imageDataUrl, bufferToDataUrl(image)).catch((error) => ({ error: error.message }));
    if (check.error || !check.faceFound) {
      return { image, faceCheck: { checked: false, headPasted: pasted, error: check.error || 'No face found in the render.' } };
    }
    return {
      image,
      faceCheck: {
        checked: true,
        method: 'sface-embedding',
        headPasted: pasted,
        similarity: check.similarity,
        threshold: check.threshold,
        passed: check.samePerson,
        alignmentShift: alignment.shift ?? null
      }
    };
  }

  // What was measured, logged next to a correction or confirmation: hue angle for the legacy thresholds,
  // L*a*b* for fitting the undertone detector's warm/cool anchors.
  const measurementLog = (skin) => ({
    measuredHueAngle: skin?.hueAngle ?? null,
    measuredIta: skin?.ita ?? null,
    measuredLab: skin?.lab ?? null,
    method: skin?.method ?? null,
    whiteBalance: skin?.whiteBalance ?? null
  });

  // The visitor says the measurement is wrong ("I'm warm, not cool"): rebuild the palette, design again,
  // and log the measured value next to the correction so the thresholds can be tuned.
  async function correctProfile(sessionId, corrections) {
    const session = get(sessionId);
    if (!session.profile) {
      throw new MirrorError('No profile yet for this session.', 409);
    }
    const before = { skinUndertone: session.profile.skinUndertone, skinDepth: session.profile.skinDepth, heightCm: session.profile.heightCm, build: session.profile.build };
    const after = { ...before, ...Object.fromEntries(Object.entries(corrections).filter(([, value]) => value)) };
    Object.assign(session.profile, after, { heightImpression: heightImpression(after.heightCm), corrected: true });
    if (corrections.skinUndertone) {
      // The visitor picked warm, neutral or cool themselves, so the measured olive cast no longer applies.
      Object.assign(session.profile, { skinUndertoneSource: 'visitor', olive: false });
    }
    if (corrections.heightCm) {
      session.profile.heightSource = 'visitor';
    }
    insights?.recordCorrection({ before, after, ...measurementLog(session.profile.skinMeasurement) });
    metrics.count('profile_corrections');

    applyContext(session, designContext(session, session.profile));
    setStatus(session, 'designing', 'Designing looks for your corrected profile…');
    session.captureAt = Date.now();
    const round = await designRound(session, '');
    render(session, round.round, 1);
    return snapshot(session);
  }

  // "Looks right": the measured undertone is confirmed, which is as useful for tuning as a correction.
  function confirmProfile(sessionId) {
    const session = get(sessionId);
    if (!session.profile) {
      throw new MirrorError('No profile yet for this session.', 409);
    }
    const measured = { skinUndertone: session.profile.skinUndertone, skinDepth: session.profile.skinDepth, heightCm: session.profile.heightCm, build: session.profile.build };
    insights?.recordCorrection({ before: measured, after: measured, confirmed: true, ...measurementLog(session.profile.skinMeasurement) });
    metrics.count('profile_confirmations');
    publish(session, 'session.profile.confirmed', {});
    return { confirmed: true };
  }

  // "Show me another": the next look in order of predicted appeal.
  function showNext(sessionId) {
    const session = get(sessionId);
    const [round, option] = (session.activeKey || '1.1').split('.').map(Number);
    if (!session.rounds[round - 1]?.options.length) {
      throw new MirrorError('No options yet.', 409);
    }
    const next = nextOption(session.rounds[round - 1], option);
    const entry = render(session, round, next);
    return { round, option: next, status: entry.status };
  }

  function rate(sessionId, { round, option, rating }) {
    const session = get(sessionId);
    const chosen = session.rounds[round - 1]?.options[option - 1];
    if (!chosen) {
      throw new MirrorError('No such option.', 404);
    }
    insights?.recordRating({
      rating,
      // No style: it can be the visitor's own words (voice search), and these notes are kept on disk.
      // A fallback "neutral" is not a measurement, so it must not teach the neutral palette.
      undertone: session.profile?.skinUndertoneSource === 'fallback' ? null : session.profile?.skinUndertone || null,
      depth: session.profile?.skinDepth || null,
      build: session.profile?.build || null,
      source: session.rounds[round - 1].source,
      finalQuality: session.variant?.finalQuality || null,
      title: chosen.title,
      colors: chosen.items.map((item) => item.colorName)
    });
    metrics.count(rating === 'up' ? 'ratings_up' : 'ratings_down');
    publish(session, 'session.rated', { round, option, rating });
    return { rated: rating };
  }

  // Hands-free control: thumbs up likes the current look, thumbs down moves on, victory keeps it.
  async function onGesture(gesture) {
    const action = GESTURE_ACTIONS[gesture];
    events.publish({ type: 'gesture', gesture, action: action || null });
    const session = [...sessions.values()].filter((s) => s.activeKey).sort((a, b) => b.lastActivity - a.lastActivity)[0];
    if (!action || !session) {
      return;
    }
    const [round, option] = session.activeKey.split('.').map(Number);
    session.lastActivity = Date.now();
    publish(session, 'session.gesture', { gesture, action, round, option });
    try {
      if (action === 'like') {
        rate(session.sessionId, { round, option, rating: 'up' });
      } else if (action === 'next') {
        rate(session.sessionId, { round, option, rating: 'down' });
        render(session, round, nextOption(session.rounds[round - 1], option));
      } else if (action === 'keep') {
        await keep(session.sessionId, { round, option });
      }
    } catch (error) {
      log.warn({ sessionId: session.sessionId, gesture, error: error.message }, 'Gesture action skipped');
    }
  }

  async function redesign(sessionId, { style, feedback, preferences }) {
    const session = get(sessionId);
    if (!session.capture) {
      throw new MirrorError('No capture yet for this session.', 409);
    }
    if (style) {
      session.style = style;
    }
    if (preferences) {
      session.preferences = { ...session.preferences, ...preferences };
      applyContext(session, designContext(session, session.profile));
    }
    setStatus(session, 'designing', 'Designing new looks…');
    session.captureAt = Date.now();
    const round = await designRound(session, feedback || '');
    render(session, round.round, 1);
    return snapshot(session);
  }

  async function keep(sessionId, { round, option }) {
    const session = get(sessionId);
    const entry = session.renders.get(`${round}.${option}`);
    if (!entry || entry.status !== 'done') {
      throw new MirrorError('That look has not finished rendering.', 409);
    }
    const kept = await looks.keep(dataUrlToBuffer(entry.imageDataUrl).buffer);
    publish(session, 'session.kept', { round, option, url: kept.url, expiresAt: kept.expiresAt, qrDataUrl: kept.qrDataUrl });
    return kept;
  }

  // The camera reports the visitor gone: the kiosk asks "Still here?" until endsAt, then the visit ends.
  function leave(session) {
    if (session.leaving) {
      return;
    }
    if (!(config.leaveGraceMs > 0)) {
      end(session, 'visitor_left');
      return;
    }
    const endsAt = Date.now() + config.leaveGraceMs;
    const timer = setTimeout(() => end(session, 'visitor_left'), config.leaveGraceMs);
    timer.unref?.();
    session.leaving = { endsAt, timer };
    publish(session, 'session.leaving', { endsAt });
  }

  // Back in view, or "Still here" pressed: the visit carries on.
  function stay(session, reason) {
    if (!session.leaving) {
      return false;
    }
    clearTimeout(session.leaving.timer);
    session.leaving = null;
    session.lastActivity = Date.now();
    publish(session, 'session.stayed', { reason });
    return true;
  }

  function stillHere(sessionId) {
    const session = get(sessionId);
    session.lastActivity = Date.now();
    return { stayed: stay(session, 'visitor') };
  }

  function end(session, reason) {
    if (!sessions.has(session.sessionId)) {
      return;
    }
    clearTimeout(session.leaving?.timer);
    session.leaving = null;
    sessions.delete(session.sessionId);
    clearTimeout(session.dwellTimer);
    session.status = 'ended';
    if (session.source === 'camera') {
      sidecar.disarm().catch(() => {});
    }
    publish(session, 'session.ended', { reason });
    log.info({ sessionId: session.sessionId, reason, seconds: Math.round((Date.now() - session.createdAt) / 1000) }, 'Session ended');
  }

  function fail(session, error) {
    log.error({ sessionId: session.sessionId, error: error.message, stack: error.stack }, 'Session failed');
    metrics.count('session_errors');
    alerts?.count('session_errors', 'Visitor sessions are failing', { threshold: 3 });
    publish(session, 'session.error', { error: friendly(error) });
    setStatus(session, 'error', friendly(error));
  }

  function friendly(error) {
    if (error instanceof BudgetExceededError) {
      return VISITOR_MESSAGES.budget;
    }
    if (error instanceof MirrorError) {
      return error.message; // written for visitors
    }
    if (error instanceof OpenAIError) {
      return error.status === 400 ? VISITOR_MESSAGES.imageRefused : VISITOR_MESSAGES.imagesUnavailable;
    }
    if (error instanceof SidecarError) {
      return VISITOR_MESSAGES.camera;
    }
    return VISITOR_MESSAGES.generic;
  }

  // The camera saw a clearly better view of the visitor's face after their photo (usually as they walk up
  // to the screen): put it onto the looks already shown. Local and free, no new render. Later renders of the
  // visit use it too. One upgrade at a time per session.
  async function upgradeFaces() {
    const targets = [...sessions.values()].filter((s) => s.source === 'camera' && s.capture && !s.upgradingFace);
    if (!targets.length) {
      return;
    }
    const face = await sidecar.bestFace();
    for (const session of targets) {
      session.upgradingFace = true;
      try {
        session.capture.render.faceRefDataUrl = face.imageDataUrl;
        for (const entry of session.renders.values()) {
          if (entry.status !== 'done' || !sessions.has(session.sessionId)) {
            continue;
          }
          const result = await sidecar.transferFace(entry.imageDataUrl, face.imageDataUrl);
          if (!result.applied) {
            continue;
          }
          entry.imageDataUrl = result.imageDataUrl;
          entry.faceCheck = { ...entry.faceCheck, headDecision: 'clearest face from the visit (updated)', clearFace: result.report };
          metrics.count('face_upgrades');
          const shown = session.activeKey === entry.key;
          publish(session, 'session.render.done', {
            round: entry.round, option: entry.option, imageDataUrl: entry.imageDataUrl, faceCheck: entry.faceCheck,
            tokens: entry.tokens, prefetch: !shown, upgraded: true
          });
        }
      } finally {
        session.upgradingFace = false;
      }
    }
  }

  // A different, nearer person became the camera's subject while a session waits for its photo: outfits
  // designed early from the previous person's skin must not be used for the new one. A session that already
  // has its photo is never ended here: the look on screen stays until the visitor leaves (presence) or
  // presses done, because a visitor walking up to the screen to look must never lose their result.
  function onSubjectReplaced() {
    metrics.count('subject_replaced');
    for (const session of sessions.values()) {
      if (session.source === 'camera' && session.status === 'waiting_for_capture') {
        if (session.speculative) {
          session.speculative.round.discarded = true; // its tokens still count against this visit's first look
          session.speculative = null;
        }
        publish(session, 'session.subject', { replaced: true });
      }
    }
  }

  function snapshot(session) {
    return {
      sessionId: session.sessionId,
      status: session.status,
      source: session.source,
      style: session.style,
      gender: session.gender || null,
      preferences: session.preferences,
      profile: session.profile,
      palette: session.palette?.palette || null,
      neutrals: session.palette?.neutrals || null,
      fitGuidance: session.fitLines,
      rounds: session.rounds.map(({ round, style, feedback, source, options, order }) => ({ round, style, feedback, source, options, order })),
      renders: [...session.renders.values()].map(({ key, round, option, status, faceCheck, imageDataUrl, error, prefetch, tokens }) => ({ key, round, option, status, faceCheck, imageDataUrl, error, prefetch, tokens })),
      activeKey: session.activeKey,
      leavingEndsAt: session.leaving?.endsAt || null,
      experiment: { finalQuality: session.variant?.finalQuality || config.finalQuality },
      degraded: session.degraded
    };
  }

  function onSidecarEvent(event) {
    if (event.type === 'state' || event.type === 'hello') {
      events.publish({ type: 'perception', state: event.state, message: event.message, ready: event.ready, heldMs: event.heldMs, holdMs: event.holdMs, armed: event.armed });
    } else if (event.type === 'profile') {
      onEarlyProfile(event.sessionId, event.profile);
    } else if (event.type === 'presence') {
      visitorPresent = Boolean(event.present);
      events.publish({ type: 'presence', present: event.present });
      for (const session of [...sessions.values()]) {
        if (event.present) {
          stay(session, 'present');
        } else if (config.autoEndOnLeave && session.source === 'camera' && session.status !== 'waiting_for_capture') {
          leave(session);
        }
      }
    } else if (event.type === 'face' && event.better) {
      upgradeFaces().catch((error) => log.warn({ error: error.message }, 'Face upgrade skipped'));
    } else if (event.type === 'subject') {
      if (event.replaced) {
        onSubjectReplaced();
      }
    } else if (event.type === 'capture') {
      onCapture(event.sessionId, event.captureId);
    } else if (event.type === 'camera') {
      events.publish({ type: 'camera', status: event.status, error: event.error || '' });
    } else if (event.type === 'gesture') {
      onGesture(event.gesture);
    }
  }

  return {
    start,
    stillHere,
    get: (sessionId) => snapshot(get(sessionId)),
    redesign,
    render: (sessionId, round, option) => {
      const session = get(sessionId);
      const entry = render(session, round, option);
      return { key: entry.key, status: entry.status };
    },
    keep,
    correctProfile,
    confirmProfile,
    showNext,
    onEarlyProfile,
    rate,
    onGesture,
    end: (sessionId, reason = 'ended_by_visitor') => end(get(sessionId), reason),
    onSidecarEvent,
    sweep(now = Date.now()) {
      for (const session of [...sessions.values()]) {
        if (now - session.lastActivity > config.sessionTtlMs) {
          end(session, 'timeout');
        }
      }
    },
    size: () => sessions.size
  };
}
