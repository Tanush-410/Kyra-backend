// Operator alerts: every alert is logged, and sent to ALERT_WEBHOOK_URL when set (a Slack-compatible
// incoming webhook: JSON { text }). Each alert key is sent at most once per cooldown, so a flapping camera
// or an outage does not flood the channel. count() raises an alert only when something happens `threshold`
// times within `windowMs` (for example, render failures).
export function createAlerts({ webhookUrl = '', cooldownMs = 15 * 60_000, fetchImpl = (...args) => globalThis.fetch(...args), log, name = 'KYRA mirror', now = () => Date.now() } = {}) {
  const lastSent = new Map();
  const occurrences = new Map();
  const sent = [];

  async function deliver(text) {
    if (!webhookUrl) {
      return false;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetchImpl(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: controller.signal
      });
      if (!response.ok) {
        log?.warn({ status: response.status }, 'Alert webhook rejected the alert');
      }
      return response.ok;
    } catch (error) {
      log?.warn({ error: error.message }, 'Alert webhook unreachable');
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  function notify(key, message, details = {}) {
    const at = now();
    if (lastSent.has(key) && at - lastSent.get(key) < cooldownMs) {
      return Promise.resolve(false);
    }
    lastSent.set(key, at);
    log?.warn({ alert: key, ...details }, message);
    sent.push({ key, message, at });
    if (sent.length > 50) {
      sent.shift();
    }
    return deliver(`[${name}] ${message}`);
  }

  function count(key, message, { threshold = 3, windowMs = 10 * 60_000, details = {} } = {}) {
    const at = now();
    const recent = (occurrences.get(key) || []).filter((time) => at - time < windowMs);
    recent.push(at);
    occurrences.set(key, recent);
    if (recent.length >= threshold) {
      occurrences.set(key, []);
      return notify(key, `${message} (${recent.length} in ${Math.round(windowMs / 60_000)} min)`, details);
    }
    return Promise.resolve(false);
  }

  return { notify, count, recent: () => [...sent], enabled: Boolean(webhookUrl) };
}
