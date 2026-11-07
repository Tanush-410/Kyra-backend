// Tunes skin undertone measurement from visitors' "that's not me" corrections and "looks right"
// confirmations. Usage: npm run tune-thresholds [-- --save]   (reads RUNTIME_DIR, default backend/.runtime)
//
// 1. Fits the sidecar's undertone detector (warm/cool anchors) to the logged L*a*b* and reports held-out
//    accuracy against the defaults. --save applies the fit (the sidecar must be running).
// 2. Suggests the legacy hue-angle thresholds, used only with UNDERTONE_ENGINE=legacy.
import path from 'node:path';
import { backendRoot, loadConfig, loadLocalEnv } from '../src/config.js';
import { createInsights } from '../src/lib/insights.js';
import { createSidecar } from '../src/lib/sidecar.js';
import { classify, MIN_SAMPLES, tuneThresholds } from '../src/lib/threshold-tuning.js';

loadLocalEnv();
const save = process.argv.includes('--save');
const dir = path.resolve(backendRoot, process.env.RUNTIME_DIR || '.runtime');
const insights = createInsights({ dir });
const pct = (x) => `${Math.round(x * 100)}%`;

const labelled = insights.undertoneSamples();
console.log(`Undertone detector: ${labelled.length} visitors with a logged L*a*b* reading`);
if (labelled.length < 6) {
  console.log(`  Need at least 6 (15+ for a held-out accuracy figure) before fitting.`);
} else {
  const config = loadConfig();
  const sidecar = createSidecar({ url: config.sidecarUrl, token: config.sidecarToken });
  try {
    const report = await sidecar.calibrateUndertone({ samples: labelled, save });
    const fit = report.fitted;
    console.log(`  Fitted: neutral ${fit.neutral_hue.toFixed(1)} deg, span ${fit.hue_span.toFixed(1)} deg, band ${fit.neutral_band.toFixed(2)}, depth slope ${fit.depth_hue_slope.toFixed(2)} deg per L*`);
    if (report.heldOutAccuracy) {
      console.log(`  Held out ${report.heldOut}: fitted ${pct(report.heldOutAccuracy.balanced_accuracy)} vs defaults ${pct(report.defaultAccuracyOnHeldOut.balanced_accuracy)} (balanced accuracy)`);
    }
    for (const note of fit.notes) {
      console.log(`  Note: ${note}`);
    }
    console.log(report.saved ? '  Saved: the sidecar uses the fit from now on.' : '  Not saved. Rerun with -- --save to apply it.');
  } catch (error) {
    console.log(`  Could not reach the sidecar at ${config.sidecarUrl}: ${error.message}`);
  } finally {
    sidecar.close();
  }
}

const samples = insights.thresholdSamples();
const result = tuneThresholds(samples);
console.log(`\nLegacy thresholds (UNDERTONE_ENGINE=legacy): ${result.samples} visitors who confirmed or corrected their undertone`);
if (!result.samples) {
  console.log('No data yet. Visitors need to use "Looks right" or "Fix my profile" in the mirror UI.');
  process.exit(0);
}
console.log(`Current:   cool <= ${result.current.coolMax} deg, warm >= ${result.current.warmMin} deg  -> ${pct(result.current.accuracy)} agree with visitors`);
console.log(`Suggested: cool <= ${result.suggested.coolMax} deg, warm >= ${result.suggested.warmMin} deg  -> ${pct(result.suggested.accuracy)} agree`);
for (const undertone of ['cool', 'neutral', 'warm']) {
  const hues = samples.filter((s) => s.undertone === undertone).map((s) => s.hue).sort((a, b) => a - b);
  if (hues.length) {
    const misread = hues.filter((hue) => classify(hue, result.current) !== undertone).length;
    console.log(`  said ${undertone.padEnd(7)} n=${String(hues.length).padStart(3)}  hue ${hues[0]}-${hues.at(-1)} deg, median ${hues[Math.floor(hues.length / 2)]}  (${misread} misread now)`);
  }
}
if (!result.enoughData) {
  console.log(`\nOnly ${result.samples} samples: collect at least ${MIN_SAMPLES} before changing anything.`);
} else {
  console.log(`\nTo apply, add to backend/.env (the sidecar inherits it):\nSKIN_COOL_MAX_HUE=${result.suggested.coolMax}\nSKIN_WARM_MIN_HUE=${result.suggested.warmMin}`);
}
