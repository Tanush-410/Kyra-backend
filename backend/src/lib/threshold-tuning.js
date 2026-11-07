// Picks the cool/warm hue-angle thresholds that best match what visitors said their undertone is
// (corrections and "looks right" confirmations), for SKIN_COOL_MAX_HUE / SKIN_WARM_MIN_HUE.
export const CURRENT_THRESHOLDS = () => ({
  coolMax: Number(process.env.SKIN_COOL_MAX_HUE) || 50,
  warmMin: Number(process.env.SKIN_WARM_MIN_HUE) || 58
});
export const MIN_SAMPLES = 10;

export function classify(hue, { coolMax, warmMin }) {
  return hue <= coolMax ? 'cool' : hue >= warmMin ? 'warm' : 'neutral';
}

// samples: [{ hue, undertone }] where undertone is what the visitor confirmed or corrected to.
export function tuneThresholds(samples, current = CURRENT_THRESHOLDS()) {
  const usable = samples.filter((s) => Number.isFinite(s.hue) && ['cool', 'neutral', 'warm'].includes(s.undertone));
  const accuracy = (t) => usable.filter((s) => classify(s.hue, t) === s.undertone).length / (usable.length || 1);

  let best = { ...current, accuracy: accuracy(current) };
  for (let coolMax = 35; coolMax <= 65; coolMax += 0.5) {
    for (let warmMin = coolMax + 0.5; warmMin <= 75; warmMin += 0.5) {
      const candidate = { coolMax, warmMin, accuracy: accuracy({ coolMax, warmMin }) };
      const distance = (t) => Math.abs(t.coolMax - current.coolMax) + Math.abs(t.warmMin - current.warmMin);
      // Higher accuracy wins; ties go to the thresholds closest to the current ones.
      if (candidate.accuracy > best.accuracy + 1e-9 || (Math.abs(candidate.accuracy - best.accuracy) < 1e-9 && distance(candidate) < distance(best))) {
        best = candidate;
      }
    }
  }
  return {
    samples: usable.length,
    enoughData: usable.length >= MIN_SAMPLES,
    current: { ...current, accuracy: round(accuracy(current)) },
    suggested: { coolMax: best.coolMax, warmMin: best.warmMin, accuracy: round(best.accuracy) }
  };
}

const round = (value) => Math.round(value * 1000) / 1000;
