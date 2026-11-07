import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export class BudgetExceededError extends Error {
  constructor(message = 'Daily OpenAI budget reached.') {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

// Daily OpenAI spend, persisted so a restart does not reset it. Each call is charged its real cost
// from token usage; the per-kind estimates are only for checking a call fits before making it.
// The ledger holds no personal data.
export function createBudget({ file, dailyUsd, costs, warnFraction = 0.8, onWarn = null, now = () => new Date() }) {
  let ledger = {};
  if (file && existsSync(file)) {
    try {
      ledger = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      ledger = {};
    }
  }

  const today = () => now().toISOString().slice(0, 10);
  // Estimated cost of calls that have started but not finished, so parallel calls cannot overspend.
  let reserved = 0;
  const entry = () => (ledger[today()] ||= { usd: 0, calls: {} });

  function save() {
    if (!file) {
      return;
    }
    const keepFrom = new Date(now().getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
    ledger = Object.fromEntries(Object.entries(ledger).filter(([day]) => day >= keepFrom));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(ledger, null, 2));
  }

  return {
    enabled: dailyUsd > 0,

    canSpend(kind) {
      return !(dailyUsd > 0) || entry().usd + reserved + (costs[kind] || 0) <= dailyUsd + 1e-9;
    },

    // Checks the call fits and reserves its estimated cost until record() or release().
    assert(kind) {
      if (!this.canSpend(kind)) {
        throw new BudgetExceededError(`Daily OpenAI budget of $${dailyUsd} reached.`);
      }
      reserved += costs[kind] || 0;
    },

    release(kind) {
      reserved = Math.max(0, reserved - (costs[kind] || 0));
    },

    // usd: the call's real cost from its token usage; the per-kind estimate is used only when unknown.
    record(kind, usd = costs[kind] || 0) {
      this.release(kind);
      const day = entry();
      const before = this.fractionUsed();
      day.usd = Math.round((day.usd + usd) * 1_000_000) / 1_000_000;
      day.calls[kind] = (day.calls[kind] || 0) + 1;
      save();
      if (onWarn && before < warnFraction && this.fractionUsed() >= warnFraction) {
        onWarn(this.summary());
      }
    },

    fractionUsed() {
      return dailyUsd > 0 ? (ledger[today()]?.usd || 0) / dailyUsd : 0;
    },

    summary() {
      const day = ledger[today()] || { usd: 0, calls: {} };
      return { date: today(), spentUsd: day.usd, limitUsd: dailyUsd || null, calls: day.calls, costs };
    }
  };
}
