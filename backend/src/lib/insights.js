import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { tuneThresholds } from './threshold-tuning.js';

const UNDERTONES = ['cool', 'neutral', 'warm'];

// Anonymous tuning data: look ratings and visitors' corrections to their measured profile.
// Lines hold no photos, names or session ids, only what is needed to tune palettes and thresholds.
export function createInsights({ dir }) {
  const ratingsFile = dir ? path.join(dir, 'ratings.jsonl') : null;
  const correctionsFile = dir ? path.join(dir, 'corrections.jsonl') : null;
  const ratings = load(ratingsFile);
  const corrections = load(correctionsFile);

  function append(file, list, record) {
    const line = { at: new Date().toISOString(), ...record };
    list.push(line);
    if (file) {
      mkdirSync(path.dirname(file), { recursive: true });
      appendFileSync(file, `${JSON.stringify(line)}\n`);
    }
  }

  return {
    recordRating(record) {
      append(ratingsFile, ratings, record);
    },

    recordCorrection(record) {
      append(correctionsFile, corrections, record);
    },

    // Like rate per colour among visitors with this undertone (smoothed), once there is enough data.
    colourScores(undertone, minRatings) {
      const relevant = ratings.filter((r) => r.undertone === undertone);
      if (!undertone || relevant.length < minRatings) {
        return null;
      }
      const tally = {};
      for (const rating of relevant) {
        for (const colour of new Set(rating.colors || [])) {
          const entry = (tally[colour] ||= { up: 0, down: 0 });
          entry[rating.rating === 'up' ? 'up' : 'down'] += 1;
        }
      }
      return Object.fromEntries(Object.entries(tally).map(([colour, { up, down }]) => [colour, { up, down, score: (up + 1) / (up + down + 2) }]));
    },

    thresholdSamples() {
      return corrections
        .filter((c) => Number.isFinite(c.measuredHueAngle) && c.after?.skinUndertone)
        .map((c) => ({ hue: c.measuredHueAngle, undertone: c.after.skinUndertone }));
    },

    // Labelled L*a*b* samples for the sidecar's undertone detector (POST /calibrate/undertone).
    undertoneSamples() {
      return corrections
        .filter((c) => c.measuredLab && Number.isFinite(c.measuredLab.L) && c.after?.skinUndertone)
        .map((c) => ({ L: c.measuredLab.L, a: c.measuredLab.a, b: c.measuredLab.b, label: c.after.skinUndertone }));
    },

    summary() {
      const rate = (list) => (list.length ? Math.round((list.filter((r) => r.rating === 'up').length / list.length) * 100) : null);
      const byUndertone = Object.fromEntries(
        UNDERTONES.map((undertone) => {
          const list = ratings.filter((r) => r.undertone === undertone);
          return [undertone, { ratings: list.length, approvalPercent: rate(list) }];
        })
      );

      // Where visitors said their undertone really is, against the measured hue angle: the data
      // for moving the cool/warm thresholds in sidecar/kyra_sidecar/color.py.
      const hueByCorrectedUndertone = {};
      for (const undertone of UNDERTONES) {
        const hues = corrections
          .filter((c) => c.after?.skinUndertone === undertone && Number.isFinite(c.measuredHueAngle))
          .map((c) => c.measuredHueAngle)
          .sort((a, b) => a - b);
        if (hues.length) {
          hueByCorrectedUndertone[undertone] = { count: hues.length, min: hues[0], median: hues[Math.floor(hues.length / 2)], max: hues.at(-1) };
        }
      }

      const byFinalQuality = {};
      for (const rating of ratings.filter((r) => r.finalQuality)) {
        (byFinalQuality[rating.finalQuality] ||= []).push(rating);
      }
      const changes = corrections.filter((c) => !c.confirmed);
      return {
        ratings: ratings.length,
        approvalPercent: rate(ratings),
        byUndertone,
        byFinalQuality: Object.fromEntries(Object.entries(byFinalQuality).map(([quality, list]) => [quality, { ratings: list.length, approvalPercent: rate(list) }])),
        corrections: changes.length,
        confirmations: corrections.length - changes.length,
        undertoneCorrections: changes.filter((c) => c.before?.skinUndertone !== c.after?.skinUndertone).length,
        hueByCorrectedUndertone,
        thresholds: tuneThresholds(this.thresholdSamples())
      };
    }
  };
}

function load(file) {
  if (!file || !existsSync(file)) {
    return [];
  }
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}
