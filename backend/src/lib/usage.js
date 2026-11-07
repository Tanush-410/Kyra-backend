// Real token usage from OpenAI responses, priced per token. Prices are USD per 1M tokens from
// OpenAI's model pages (checked 6 Nov 2026); override with PRICES_JSON if they change.
export const DEFAULT_PRICES = {
  'gpt-5.2': { input: 1.75, cachedInput: 0.175, output: 14 },
  'gpt-image-1.5': { textInput: 5, cachedTextInput: 1.25, imageInput: 8, cachedImageInput: 2, textOutput: 10, imageOutput: 32 }
};

const MAX_CALLS = 500;

// Normalises the two usage shapes: Responses API (text) and Images API.
export function normaliseUsage(usage, endpoint) {
  if (!usage) {
    return null;
  }
  if (endpoint === 'images') {
    const details = usage.input_tokens_details || {};
    const imageInput = details.image_tokens ?? 0;
    const textInput = details.text_tokens ?? Math.max(0, (usage.input_tokens || 0) - imageInput);
    // Output is split into image tokens ($32/M) and text tokens ($10/M) when the API reports it.
    const outputDetails = usage.output_tokens_details || {};
    const imageOutput = outputDetails.image_tokens ?? usage.output_tokens ?? 0;
    return {
      inputTokens: usage.input_tokens || 0,
      textInputTokens: textInput,
      imageInputTokens: imageInput,
      outputTokens: usage.output_tokens || 0,
      imageOutputTokens: imageOutput,
      textOutputTokens: outputDetails.text_tokens ?? Math.max(0, (usage.output_tokens || 0) - imageOutput),
      totalTokens: usage.total_tokens || (usage.input_tokens || 0) + (usage.output_tokens || 0)
    };
  }
  return {
    inputTokens: usage.input_tokens || 0,
    cachedInputTokens: usage.input_tokens_details?.cached_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens || 0,
    totalTokens: usage.total_tokens || (usage.input_tokens || 0) + (usage.output_tokens || 0)
  };
}

export function priceUsage(model, endpoint, tokens, prices = DEFAULT_PRICES) {
  const price = prices[model];
  if (!price || !tokens) {
    return null;
  }
  const perToken = (usdPerMillion) => (usdPerMillion || 0) / 1_000_000;
  if (endpoint === 'images') {
    return (
      tokens.textInputTokens * perToken(price.textInput) +
      tokens.imageInputTokens * perToken(price.imageInput) +
      tokens.imageOutputTokens * perToken(price.imageOutput) +
      tokens.textOutputTokens * perToken(price.textOutput)
    );
  }
  const uncached = tokens.inputTokens - tokens.cachedInputTokens;
  return uncached * perToken(price.input) + tokens.cachedInputTokens * perToken(price.cachedInput) + tokens.outputTokens * perToken(price.output);
}

export function createUsageLog({ prices = DEFAULT_PRICES } = {}) {
  const calls = [];

  return {
    record({ endpoint, model, kind, usage }) {
      const tokens = normaliseUsage(usage, endpoint);
      if (!tokens) {
        return null;
      }
      const usd = priceUsage(model, endpoint, tokens, prices);
      const call = { at: Date.now(), endpoint, model, kind, ...tokens, usd: usd === null ? null : Math.round(usd * 1e6) / 1e6 };
      calls.push(call);
      if (calls.length > MAX_CALLS) {
        calls.shift();
      }
      return call;
    },

    summary() {
      const byKind = {};
      for (const call of calls) {
        const entry = (byKind[call.kind] ||= { calls: 0, inputTokens: 0, imageInputTokens: 0, outputTokens: 0, imageOutputTokens: 0, reasoningTokens: 0, usd: 0 });
        entry.calls += 1;
        entry.inputTokens += call.inputTokens;
        entry.imageInputTokens += call.imageInputTokens || 0;
        entry.outputTokens += call.outputTokens;
        entry.imageOutputTokens += call.imageOutputTokens || 0;
        entry.reasoningTokens += call.reasoningTokens || 0;
        entry.usd = Math.round((entry.usd + (call.usd || 0)) * 1e6) / 1e6;
      }
      return { calls: calls.length, usd: Math.round(calls.reduce((sum, c) => sum + (c.usd || 0), 0) * 1e6) / 1e6, byKind, recent: calls.slice(-20) };
    }
  };
}
