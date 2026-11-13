import { dataUrlToBuffer, parseJsonOutput } from './normalize.js';

const RETRYABLE_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);
const MAX_BACKOFF_MS = 15_000;

export class OpenAIError extends Error {
  constructor(message, { status = 0, retryable = false } = {}) {
    super(message);
    this.name = 'OpenAIError';
    this.status = status;
    this.retryable = retryable;
  }
}

export function createOpenAI({
  apiKey,
  model,
  imageModel,
  timeoutMs = 120_000,
  maxRetries = 3,
  fetchImpl = (...args) => globalThis.fetch(...args),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = null,
  budget = null,
  usageLog = null,
  baseUrl = 'https://api.openai.com/v1',
  inputFidelity = '',
  reasoningEffort = ''
}) {
  let streamingSupported = true;
  let textStreamingSupported = true;
  let reasoningSupported = Boolean(reasoningEffort);
  // input_fidelity=high keeps faces and features closer to the photo; dropped for good if the model rejects it.
  let fidelity = inputFidelity;

  async function request(pathname, makeInit, { raw = false } = {}) {
    if (!apiKey) {
      throw new OpenAIError('OPENAI_API_KEY is missing on backend environment.');
    }

    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      let json;

      try {
        const init = makeInit();
        response = await fetchImpl(`${baseUrl}${pathname}`, {
          ...init,
          headers: { Authorization: `Bearer ${apiKey}`, ...(init.headers || {}) },
          signal: controller.signal
        });
        if (raw && response.ok) {
          // Streaming: the caller reads the body; the timeout must cover the whole stream.
          return { response, done: () => clearTimeout(timeoutId) };
        }
        json = await response.json().catch(() => ({}));
      } catch (error) {
        const timedOut = error?.name === 'AbortError';
        lastError = new OpenAIError(timedOut ? 'OpenAI request timed out.' : `OpenAI request failed: ${error?.message}`, {
          retryable: true
        });
      } finally {
        if (!(raw && response?.ok)) {
          clearTimeout(timeoutId);
        }
      }

      if (response?.ok) {
        return json;
      }

      if (response) {
        // Quota exhaustion comes back as 429 but will not recover by waiting.
        const quotaExhausted = json?.error?.code === 'insufficient_quota';
        lastError = new OpenAIError(json?.error?.message || `OpenAI request failed with status ${response.status}.`, {
          status: response.status,
          retryable: RETRYABLE_STATUSES.has(response.status) && !quotaExhausted
        });
      }

      if (!lastError.retryable || attempt === maxRetries) {
        throw lastError;
      }

      const waitMs = retryDelayMs(response, attempt);
      log?.warn({ pathname, attempt: attempt + 1, status: lastError.status, waitMs }, 'Retrying OpenAI request');
      await sleep(waitMs);
    }

    throw lastError;
  }

  // Records real token usage from a response and charges the budget with its real cost.
  // onUsage(call) lets the caller attribute the tokens, e.g. to one visitor's look.
  function account(endpoint, kind, usage, budgetKind, onUsage) {
    const call = usageLog?.record({ endpoint, model: endpoint === 'images' ? imageModel : model, kind, usage });
    budget?.record(budgetKind, call?.usd ?? undefined);
    onUsage?.(call || { totalTokens: (usage?.input_tokens || 0) + (usage?.output_tokens || 0), usd: null });
  }

  // Runs a paid call: reserves its estimated cost, and frees the reservation if it fails.
  async function paid(budgetKind, run) {
    budget?.assert(budgetKind);
    try {
      return await run();
    } catch (error) {
      budget?.release(budgetKind);
      throw error;
    }
  }

  // kind labels the call in usage reports (design, photo_check, face_check, review...).
  function respond(options) {
    return paid('text', () => respondUnchecked(options));
  }

  async function respondUnchecked({ text, images = [], schema = null, kind = 'text', onUsage }) {
    const makeInit = () => ({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        ...(reasoningSupported ? { reasoning: { effort: reasoningEffort } } : {}),
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text },
              ...images.map((imageUrl) => ({ type: 'input_image', image_url: imageUrl }))
            ]
          }
        ],
        ...(schema ? { text: { format: { type: 'json_schema', name: schema.name, strict: true, schema: schema.schema } } } : {})
      })
    });
    let json;
    try {
      json = await request('/responses', makeInit);
    } catch (error) {
      if (!(reasoningSupported && error instanceof OpenAIError && error.status === 400 && /reasoning/i.test(error.message))) {
        throw error;
      }
      log?.warn({ error: error.message }, 'Model does not accept reasoning effort; retrying without it');
      reasoningSupported = false;
      json = await request('/responses', makeInit);
    }
    account('responses', kind, json?.usage, 'text', onUsage);
    return extractOutputText(json);
  }

  // Streams a text response; onText(fullTextSoFar) is called as deltas arrive. Falls back to respond().
  function respondStream(options) {
    return paid('text', () => respondStreamUnchecked(options));
  }

  async function respondStreamUnchecked({ text, images = [], schema = null, onText, kind = 'text', onUsage }) {
    if (!textStreamingSupported) {
      const full = await respondUnchecked({ text, images, schema, kind, onUsage });
      onText?.(full);
      return full;
    }
    const body = {
      model,
      stream: true,
      ...(reasoningSupported ? { reasoning: { effort: reasoningEffort } } : {}),
      input: [{ role: 'user', content: [{ type: 'input_text', text }, ...images.map((imageUrl) => ({ type: 'input_image', image_url: imageUrl }))] }],
      ...(schema ? { text: { format: { type: 'json_schema', name: schema.name, strict: true, schema: schema.schema } } } : {})
    };
    let full = '';
    let usage = null;
    try {
      const { response, done } = await request(
        '/responses',
        () => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        { raw: true }
      );
      try {
        if (!(response.headers.get('content-type') || '').includes('text/event-stream')) {
          const json = await response.json();
          usage = json?.usage || null;
          full = extractOutputText(json);
          onText?.(full);
        }
        for await (const event of full ? [] : readSse(response)) {
          if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
            full += event.delta;
            onText?.(full);
          } else if (event.type === 'response.completed') {
            usage = event.response?.usage || null;
          } else if (event.type === 'response.failed' || event.type === 'error') {
            throw new OpenAIError(event.response?.error?.message || event.error?.message || 'Response stream failed.');
          }
        }
      } finally {
        done();
      }
    } catch (error) {
      if (error instanceof OpenAIError && error.status === 400 && /stream/i.test(error.message)) {
        log?.warn({ error: error.message }, 'Response streaming unsupported; falling back');
        textStreamingSupported = false;
        return respondStreamUnchecked({ text, images, schema, onText, kind, onUsage });
      }
      throw error;
    }
    account('responses', kind, usage, 'text', onUsage);
    return full;
  }

  async function respondJson(options) {
    const outputText = await respond(options);
    try {
      return parseJsonOutput(outputText);
    } catch {
      throw new OpenAIError('Model returned invalid JSON.');
    }
  }

  // mask: optional PNG data URL whose transparent pixels mark the editable area of the first image.
  // onPartial(base64, index): receives streamed preview images when partialImages > 0.
  // quality: low | medium | high | auto. budgetKind lets cheap drafts be counted separately.
  function editImage(options) {
    return paid(options.budgetKind || 'image', async () => {
      try {
        return await editImageUnchecked(options);
      } catch (error) {
        if (!(fidelity && error instanceof OpenAIError && error.status === 400 && /fidelity/i.test(error.message))) {
          throw error;
        }
        log?.warn({ error: error.message }, 'Image model does not accept input_fidelity; retrying without it');
        fidelity = '';
        return editImageUnchecked(options);
      }
    });
  }

  // usageKind labels the call in usage reports (e.g. image:low vs image:medium for the quality test).
  async function editImageUnchecked({ prompt, images, size = '1024x1536', mask = null, partialImages = 0, onPartial = null, quality = '', budgetKind = 'image', usageKind = budgetKind, onUsage }) {
    const parts = images.map((image) => ({ ...dataUrlToBuffer(image.dataUrl), filename: image.filename }));
    const maskPart = mask ? dataUrlToBuffer(mask) : null;
    if (!parts.length || parts.some((part) => !part.buffer) || (mask && !maskPart)) {
      throw new OpenAIError('Image payload is invalid for virtual try-on.');
    }

    const stream = partialImages > 0 && typeof onPartial === 'function' && streamingSupported;
    const makeInit = (withStream) => () => {
      const formData = new FormData();
      formData.append('model', imageModel);
      formData.append('prompt', prompt);
      formData.append('size', size);
      if (quality) {
        formData.append('quality', quality);
      }
      if (fidelity) {
        formData.append('input_fidelity', fidelity);
      }
      for (const part of parts) {
        formData.append('image[]', new Blob([part.buffer], { type: part.mime }), part.filename);
      }
      if (maskPart) {
        formData.append('mask', new Blob([maskPart.buffer], { type: 'image/png' }), 'mask.png');
      }
      if (withStream) {
        formData.append('stream', 'true');
        formData.append('partial_images', String(Math.min(3, partialImages)));
      }
      return { method: 'POST', body: formData };
    };

    let base64 = '';
    let usage = null;
    if (stream) {
      try {
        const { response, done } = await request('/images/edits', makeInit(true), { raw: true });
        try {
          ({ base64, usage } = await readImageStream(response, onPartial));
        } finally {
          done();
        }
      } catch (error) {
        if (error instanceof OpenAIError && error.status === 400 && /stream|partial/i.test(error.message)) {
          log?.warn({ error: error.message }, 'Image streaming unsupported; falling back to a single response');
          streamingSupported = false;
        } else {
          throw error;
        }
      }
    }
    if (!base64) {
      const json = await request('/images/edits', makeInit(false));
      base64 = extractOutputImageBase64(json);
      usage = json?.usage || null;
    }
    if (!base64) {
      throw new OpenAIError('Model returned no generated image payload.');
    }
    account('images', usageKind, usage, budgetKind, onUsage);
    return base64;
  }

  // A new picture from text alone (product photos of single pieces). background: transparent | opaque | auto.
  function generateImage(options) {
    return paid(options.budgetKind || 'photo', () => generateImageUnchecked(options));
  }

  async function generateImageUnchecked({ prompt, size = '1024x1024', quality = 'low', background = 'transparent', budgetKind = 'photo', usageKind = budgetKind, onUsage }) {
    const body = { model: imageModel, prompt, size, n: 1, ...(quality ? { quality } : {}), ...(background ? { background } : {}) };
    const json = await request('/images/generations', () => ({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }));
    const base64 = extractOutputImageBase64(json);
    if (!base64) {
      throw new OpenAIError('Model returned no generated image payload.');
    }
    account('images', usageKind, json?.usage || null, budgetKind, onUsage);
    return base64;
  }

  return { isConfigured: Boolean(apiKey), respond, respondStream, respondJson, editImage, generateImage };
}

async function* readSse(response) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('');
      if (!data || data === '[DONE]') {
        continue;
      }
      try {
        yield JSON.parse(data);
      } catch {
        // ignore malformed event
      }
    }
  }
}

async function readImageStream(response, onPartial) {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    const json = await response.json();
    return { base64: extractOutputImageBase64(json), usage: json?.usage || null };
  }

  let finalImage = '';
  let usage = null;
  for await (const event of readSse(response)) {
    if (event.type === 'error' || event.error) {
      throw new OpenAIError(event.error?.message || 'Image stream failed.');
    }
    if (String(event.type).endsWith('partial_image') && event.b64_json) {
      onPartial(event.b64_json, event.partial_image_index ?? 0);
    } else if (String(event.type).endsWith('completed') && event.b64_json) {
      finalImage = event.b64_json;
      usage = event.usage || null;
    }
  }
  return { base64: finalImage, usage };
}

function retryDelayMs(response, attempt) {
  const retryAfterMs = Number(response?.headers?.get?.('retry-after-ms'));
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return Math.min(retryAfterMs, MAX_BACKOFF_MS);
  }
  const retryAfterSeconds = Number(response?.headers?.get?.('retry-after'));
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(retryAfterSeconds * 1000, MAX_BACKOFF_MS);
  }
  return Math.min(1000 * 2 ** attempt + Math.random() * 250, MAX_BACKOFF_MS);
}

export function extractOutputText(json) {
  if (typeof json?.output_text === 'string' && json.output_text.trim().length > 0) {
    return json.output_text.trim();
  }

  const contentEntries = json?.output?.flatMap((item) => item?.content || []).filter((entry) => entry?.text) || [];
  return contentEntries.map((entry) => entry.text).join('\n').trim();
}

export function extractOutputImageBase64(json) {
  if (typeof json?.data?.[0]?.b64_json === 'string' && json.data[0].b64_json.length > 0) {
    return json.data[0].b64_json;
  }

  for (const item of json?.output || []) {
    if (item?.type === 'image_generation_call' && typeof item?.result === 'string' && item.result.length > 0) {
      return item.result;
    }
    for (const piece of item?.content || []) {
      if (piece?.type === 'output_image' && typeof (piece.image_base64 || piece.b64_json) === 'string') {
        return piece.image_base64 || piece.b64_json;
      }
    }
  }
  return '';
}
