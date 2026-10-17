// The vision request itself.
//
// One OpenAI-compatible chat-completions call carrying the image as a base64
// data URL. Only transport concerns live here: the protocol text is a separate
// editable asset, and the handoff assembly is a separate module.

import { probeImage } from './image-size.mjs';

export class VisionError extends Error {
  constructor(message, { code = 'READ_FIGURE_VISION', status, body } = {}) {
    super(message);
    this.name = 'VisionError';
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

/**
 * Ask a vision model about one or more images.
 *
 * @param {object} opts
 * @param {string[]} opts.images            image paths, sent in order
 * @param {string} opts.system              protocol text (system message)
 * @param {string} opts.text                the user turn
 * @param {object} opts.config              normalized config
 * @param {string} opts.apiKey              bearer token
 * @param {AbortSignal} [opts.signal]       caller cancellation, forwarded as-is
 * @returns {Promise<{ content: string, reasoning: string, finish: string|undefined, usage: object|undefined, seconds: number, images: object[] }>}
 */
export async function callVision({ images, system, text, config, apiKey, signal }) {
  const probed = images.map((p) => ({ path: p, ...probeImage(p) }));
  const content = [{ type: 'text', text }];
  const { readFileSync } = await import('node:fs');
  for (const im of probed) {
    const b64 = readFileSync(im.path).toString('base64');
    content.push({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${b64}` } });
  }

  const body = {
    model: config.model,
    max_tokens: config.maxTokens,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content },
    ],
  };
  // The reasoning knob is provider-specific; omit it rather than send an empty
  // value, so a strict endpoint is never handed a field it did not ask for.
  if (config.reasoningEffort) body.reasoning_effort = config.reasoningEffort;

  // Two deadlines, deliberately: our own timer covers a model that trickles
  // bytes, and the caller's signal covers a cancelled turn. Either one aborts.
  const timer = new AbortController();
  const timeout = setTimeout(() => timer.abort(new Error(`超时 ${config.timeoutMs} ms`)), config.timeoutMs);
  const onAbort = () => timer.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  const started = Date.now();
  let response;
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: timer.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    signal?.removeEventListener?.('abort', onAbort);
    if (signal?.aborted) throw new VisionError('识图请求已被调用方取消', { code: 'READ_FIGURE_ABORTED' });
    throw new VisionError(`视觉模型请求失败：${err?.message ?? err}`, { code: 'READ_FIGURE_TRANSPORT' });
  }

  try {
    const raw = await response.text();
    if (!response.ok) {
      throw new VisionError(
        `视觉模型返回 HTTP ${response.status}：${raw.slice(0, 500)}`,
        { code: 'READ_FIGURE_HTTP', status: response.status, body: raw.slice(0, 2000) },
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new VisionError(`视觉模型返回的不是 JSON：${raw.slice(0, 300)}`, { code: 'READ_FIGURE_MALFORMED' });
    }
    const choice = parsed.choices?.[0] ?? {};
    const message = choice.message ?? {};
    const finish = choice.finish_reason;
    const content = typeof message.content === 'string' ? message.content : '';
    const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : '';
    // A reasoning model can spend the whole budget on its thinking chain and
    // return an empty answer with finish_reason "length". That is a failure of
    // this call, not an empty handoff, so it must not be returned as success.
    if (!content.trim()) {
      throw new VisionError(
        `视觉模型没有输出正文（finish_reason=${finish}，思考链 ${reasoning.length} 字符）。` +
          '多半是 maxTokens 被思考链吃光：请提高 config.maxTokens 或把 reasoningEffort 降到 low。',
        { code: 'READ_FIGURE_EMPTY', body: reasoning.slice(0, 300) },
      );
    }
    return {
      content: content.trim(),
      reasoning,
      finish,
      usage: parsed.usage,
      seconds: (Date.now() - started) / 1000,
      images: probed,
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener?.('abort', onAbort);
  }
}
