// The single pipeline both surfaces share.
//
// The Cordis tool and the CLI are two doors into this function, so a fix or a
// protocol change lands in exactly one place. Everything here is text in, text
// out; nothing about Cordis or about argument parsing lives in this module.

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, basename, resolve, sep } from 'node:path';
import { normalizeConfig, resolveApiKey } from './config.mjs';
import { loadProtocol, buildTranscribeRequest, buildFollowUpRequest, EXECUTION_NOTES } from './prompt.mjs';
import { probeImage, describeImageSize } from './image-size.mjs';
import { callVision } from './vision.mjs';
import { decodeGray, decodeGrayPng } from './jpeg.mjs';
import { findSpecks } from './scan.mjs';

/**
 * Describe figures for a text-only model.
 *
 * @param {object} input
 * @param {string[]} input.images     image paths, in the order they should be presented
 * @param {string|string[]} [input.label] 题号/图名, one string or one per image
 * @param {string} [input.question]  a directed follow-up question instead of a first pass
 * @param {object} [input.config]    row config or CLI flags; normalized here
 * @param {string} [input.apiKey]    explicit credential, overriding environment
 * @param {AbortSignal} [input.signal]
 * @param {string} [input.outPath]   where to write the handoff, when the caller wants a file
 * @returns {Promise<object>} the handoff text plus the provenance needed to audit it
 */
/**
 * Run the pixel scan over each figure, degrading to null on any failure.
 *
 * A scan is an enhancement, never a precondition: the vision model can still
 * transcribe a figure whose pixels this code cannot decode, so a decode error
 * must not cost the caller the whole (paid) request. The failure is recorded and
 * surfaced in the provenance line instead of being swallowed.
 *
 * @returns {{scans: (object|null)[], scanError: string|null}}
 */
function scanFigures(paths, rawConfig) {
  const scans = [];
  let scanError = null;
  for (const p of paths) {
    try {
      const buf = readFileSync(p);
      const image = p.toLowerCase().endsWith('.png') ? decodeGrayPng(buf) : decodeGray(buf);
      const scan = findSpecks(image);
      scans.push(scan);
    } catch (err) {
      scans.push(null);
      if (scanError === null) scanError = `${basename(p)}: ${err.message}`;
    }
  }
  return { scans, scanError };
}

export async function describeFigures(input) {
  const images = (Array.isArray(input.images) ? input.images : [input.images]).filter(Boolean);
  if (!images.length) throw new Error('read-figure: 至少要给一张图片路径');
  const config = normalizeConfig(input.config);
  const { key: apiKey, source: keySource } = input.apiKey
    ? { key: String(input.apiKey).trim(), source: 'explicit' }
    : resolveApiKey(config);

  const paths = images.map((p) => resolve(p));
  const imageInfo = paths.map((p) => ({ path: p, ...probeImage(p) }));
  const { scans, scanError } = scanFigures(paths, input.config);

  const labels = normalizeLabels(input.label, paths.length);
  const question = input.question ? String(input.question).trim() : '';
  const protocol = loadProtocol(config);

  const request = question
    ? buildFollowUpRequest({ question, label: labels[0] })
    : buildTranscribeRequest({
        label: labels.length === 1 ? labels[0] : undefined,
        images: paths,
        imageInfo,
        problemText: input.problemText,
        scans,
      });

  const answer = await callVision({
    images: paths,
    system: protocol.text,
    text: request,
    config,
    apiKey,
    signal: input.signal,
  });

  const provenance = {
    model: config.model,
    baseUrl: config.baseUrl,
    protocolFile: protocol.path,
    keySource,
    effort: config.reasoningEffort || null,
    finish: answer.finish ?? null,
    seconds: Number(answer.seconds.toFixed(1)),
    usage: answer.usage ?? null,
    reasoningChars: answer.reasoning.length,
    images: imageInfo.map((im) => ({
      path: im.path,
      name: basename(im.path),
      width: im.width,
      height: im.height,
      bytes: im.bytes,
      format: im.format,
    })),
    label: labels.length === 1 ? labels[0] : labels,
    question: question || null,
    generatedAt: new Date().toISOString(),
  };

  const handoff = finalizeHandoff(composeHandoff({ question, answer: answer.content, labels, imageInfo, provenance }), provenance);
  const result = { handoff, answer: answer.content, provenance, protocol: protocol.text, request };

  if (input.outPath) {
    const written = writeHandoff(input.outPath, handoff, config);
    result.outPath = written.path;
  }
  return result;
}

/**
 * Fill in the provenance line with what actually happened on the wire.
 *
 * The handoff is an auditable record, so it states its own cost and stop reason:
 * a truncated `finish=length` and a complete `finish=stop` produce text that looks
 * equally finished, and only this line tells the two apart. The line is inserted
 * rather than templated so that `composeHandoff` stays usable on its own.
 */
export function finalizeHandoff(text, provenance) {
  const u = provenance.usage ?? {};
  const reasoning = u.completion_tokens_details?.reasoning_tokens;
  const parts = [`${provenance.seconds}s`];
  if (provenance.finish) parts.push(`finish=${provenance.finish}`);
  if (u.prompt_tokens !== undefined) {
    const cached = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens;
    parts.push(`prompt ${u.prompt_tokens} tokens${cached ? `（缓存 ${cached}）` : ''}`);
  }
  if (u.completion_tokens !== undefined) parts.push(`completion ${u.completion_tokens}${reasoning ? `（其中思考 ${reasoning}）` : ''}`);
  if (provenance.keySource) parts.push(`密钥来源 ${provenance.keySource}`);
  const line = `> 本次调用：${parts.join(' · ')}\n`;
  const anchor = '> 分工：';
  if (!text.includes(anchor)) return `${line}${text}`;
  return text.replace(anchor, `${line}${anchor}`);
}

function normalizeLabels(label, count) {
  if (!label) return [];
  const list = Array.isArray(label) ? label.map((s) => String(s).trim()) : [String(label).trim()];
  return list.filter(Boolean).slice(0, Math.max(count, 1));
}

/**
 * Assemble the exact markdown a text-only model is meant to read.
 *
 * The order is fixed on purpose: what the figure is, what the vision model
 * reported, then the rules that keep the reader from inventing geometry the
 * description never stated.
 */
export function composeHandoff({ question, answer, labels, imageInfo, provenance }) {
  const title = labels.length ? labels.join('、') : imageInfo.map((i) => basename(i.path)).join('、');
  const head = question
    ? `# 识图交接件 · 定向追问答复\n\n> 追问对象：${title}\n> 问题：${question}\n`
    : `# 识图交接件 · ${title}\n`;
  const meta =
    `> 由 read-figure 自动生成，视觉模型 \`${provenance.model}\`，${provenance.generatedAt}。\n` +
    `> 源图：${imageInfo.map((i) => `\`${i.path}\`（${i.width}×${i.height}px，${(i.bytes / 1024).toFixed(0)} KB）`).join('、')}\n` +
    '> 分工：图像描述与复述由看图模型完成，物理解答由纯文本模型完成。**本文件不含任何解答。**\n';
  const body = question ? `${answer}\n` : `${answer}\n\n---\n\n${EXECUTION_NOTES}\n`;
  return `${head}\n${meta}\n---\n\n${body}`;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Validate a handoff destination without writing it, so a bad path is refused
 * before the vision call is paid for.
 *
 * @returns {string} the absolute destination
 */
export function resolveHandoffPath(outPath, config = {}) {
  if (!outPath) throw new Error('read-figure: 没有给出交接件路径');
  const target = resolve(String(outPath));
  if (config.handoffDir) {
    const root = resolve(config.handoffDir);
    if (target !== root && !target.startsWith(root.endsWith(sep) ? root : root + sep)) {
      throw new Error(`read-figure: 拒绝写到 config.handoffDir（${root}）之外：${target}`);
    }
  }
  const name = basename(target);
  if (WINDOWS_RESERVED.test(name)) throw new Error(`read-figure: 文件名不可用：${name}`);
  return target;
}

/**
 * Write a handoff file, refusing to leave a directory the caller named.
 *
 * @returns {{ path: string, bytes: number }}
 */
export function writeHandoff(outPath, text, config = {}) {
  const target = resolveHandoffPath(outPath, config);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text, 'utf8');
  return { path: target, bytes: Buffer.byteLength(text, 'utf8') };
}

/** One-line provenance summary for logs and CLI output. */
export function summarize(result) {
  const p = result.provenance;
  const imgs = p.images.map((i) => `${i.name} ${i.width}×${i.height}px`).join('、');
  return `${p.model} · ${p.seconds}s · finish=${p.finish} · ${imgs}`;
}

export { describeImageSize, EXECUTION_NOTES };
