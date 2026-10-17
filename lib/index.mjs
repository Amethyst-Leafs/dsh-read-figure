// read-figure — a Cordis host plugin that gives a text-only model a figure.
//
// The problem this solves is a seam, not a feature: the harness can already
// send an attached image to a vision model, but a plain-text model has no way to
// ask a specific file on disk to be described, and no shared contract for what
// that description must contain. This plugin owns exactly one tool that closes
// that seam, and the value it carries is the handoff protocol in prompts/.
//
// Conventions follow the Harness plugin development skill: register inside
// `apply` through a context effect, put every tunable in Config, keep optional
// services out of hard injection.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { describeFigures, writeHandoff, composeHandoff, resolveHandoffPath, finalizeHandoff } from './describe-figure.mjs';
import { normalizeConfig, resolveApiKey, readCredentialRefs, credentialCandidates, EFFORTS, credentialsPath, DEFAULTS, defaults } from './config.mjs';
import { describeImageSize, probeImage } from './image-size.mjs';
import { findSpecks } from './scan.mjs';
import { decodeGray, decodeGrayPng } from './jpeg.mjs';
import { VisionError } from './vision.mjs';

export const name = 'read-figure';

/**
 * Loader Config, as a Standard Schema.
 *
 * The Loader does not read this object; it reads `Config['~standard'].validate`
 * (cordis `resolveConfig`). A plain map of field descriptors used to sit here and
 * a live profile refused to activate the entry with
 * `TypeError: Cannot read properties of undefined (reading 'validate')` — a
 * failure no offline test could see, because the defect was in the shape of the
 * contract rather than in any value it carries.
 *
 * The official plugins use `@deepseek-ai/schemastery` here. This one implements
 * the same interface by hand for two reasons: it keeps the plugin resolvable
 * with zero installed dependencies (`npm run check` runs it under plain Node,
 * outside any DSH installation), and it lets the schema and the normalizer
 * genuinely share one source of truth.
 *
 * On success it returns the raw config unchanged — deliberately. Merging
 * defaults here would create a second place where a default lives, and the way
 * that ends is already on record: the schema said 8000, the normalizer said
 * 32000, and an empty `config` silently picked the one that yields an empty
 * handoff. `normalizeConfig` stays the only thing that fills defaults.
 */
const FIELD_KINDS = {
  baseUrl: { kind: 'url', values: null },
  model: { kind: 'string', values: null },
  apiKey: { kind: 'string', values: null },
  maxTokens: { kind: 'integer', values: null, min: 1 },
  reasoningEffort: { kind: 'string', values: EFFORTS },
  timeoutMs: { kind: 'integer', values: null, min: 1000 },
  promptFile: { kind: 'string', values: null },
  extraInstruction: { kind: 'string', values: null },
  handoffDir: { kind: 'string', values: null },
  writeHandoff: { kind: 'boolean', values: null },
};

function describeField(name, spec) {
  switch (spec.kind) {
    case 'url':
      return '必须是 http(s) 的 URL';
    case 'integer':
      return `必须是 ≥ ${spec.min} 的整数`;
    case 'boolean':
      return '必须是 true 或 false';
    default:
      return spec.values ? `只能是 ${spec.values.join(' / ')}` : '必须是字符串';
  }
}

function checkField(field, spec, value) {
  if (value === undefined || value === null) return null;
  switch (spec.kind) {
    case 'url': {
      if (typeof value !== 'string') return describeField(field, spec);
      let parsed;
      try {
        parsed = new URL(value);
      } catch {
        return describeField(field, spec);
      }
      // An http URL with no host is not somewhere a request can go.
      return parsed.protocol === 'http:' || parsed.protocol === 'https:'
        ? (parsed.hostname ? null : describeField(field, spec))
        : describeField(field, spec);
    }
    case 'integer':
      return Number.isInteger(value) && value >= spec.min ? null : describeField(field, spec);
    case 'boolean':
      return typeof value === 'boolean' ? null : describeField(field, spec);
    default:
      if (typeof value !== 'string') return describeField(field, spec);
      return !spec.values || spec.values.includes(value) ? null : describeField(field, spec);
  }
}

export const Config = {
  // Every field is optional: an incomplete row is preferable to a row that
  // cannot start, and the normalizer supplies the rest.
  '~standard': {
    version: 1,
    vendor: 'read-figure',
    validate(raw) {
      const input = raw ?? {};
      if (typeof input !== 'object' || Array.isArray(input)) {
        return { issues: [{ message: 'config 必须是一个对象', path: [] }] };
      }
      const issues = [];
      for (const [field, spec] of Object.entries(FIELD_KINDS)) {
        const problem = checkField(field, spec, input[field]);
        if (problem) issues.push({ message: `config.${field} ${problem}`, path: [field] });
      }
      // Unknown keys are reported rather than dropped: a typo in a hand-written
      // patch row is otherwise indistinguishable from a setting that works.
      for (const field of Object.keys(input)) {
        if (!(field in FIELD_KINDS)) {
          issues.push({ message: `config 里有未知字段 ${field}（可用：${Object.keys(FIELD_KINDS).join(', ')}）`, path: [field] });
        }
      }
      return issues.length ? { issues } : { value: input };
    },
  },
  // The field list, exposed so tests can assert the schema and the normalizer
  // stay in step without reaching into the implementation.
  fields: Object.freeze(Object.keys(FIELD_KINDS)),
};

export const inject = ['tools'];

const TOOL_NAME = 'read_figure';

export function apply(ctx, config) {
  let resolved;
  try {
    resolved = normalizeConfig(config);
  } catch (err) {
    ctx.logger?.warn?.(`read-figure: 配置有问题，本次不注册工具：${err.message}`);
    return;
  }

  // Report a missing credential once, at mount, instead of after a model has
  // already decided to call the tool and burned a turn on it.
  let mounted = true;
  try {
    resolveApiKey(resolved);
  } catch (err) {
    mounted = false;
    ctx.logger?.warn?.(err.message);
  }
  if (!mounted) return;

  ctx.effect(() => ctx.tools.register(defineReadFigure(resolved)));
  ctx.logger?.info?.(`read-figure: 已注册工具 ${TOOL_NAME}（${resolved.model} @ ${resolved.baseUrl}）`);
}

/**
 * The tool definition.
 *
 * Kept as an exported factory so a test can execute it without a live Loader:
 * the definition is plain data plus one function.
 */
export function defineReadFigure(config) {
  return {
    name: TOOL_NAME,
    description:
      '把磁盘上的题图交给视觉模型，取回一份三段式「识图交接件」（图的结构 / 复述 / ⚠ 读图置信度声明），' +
      '作为文本注入你的上下文。当你要处理的题目带图、而你自己看不到图时，先调用本工具，再据交接件作答。' +
      '交接件只描述图与题面条件，不含任何解答。' +
      '需要确认某一处细节（是否打结、哪面粗糙、箭头朝向、某个黑点是构件还是噪点）时，' +
      '把「两种可能读法」写进 question 再调一次，只回答该问题，不会重写整份交接件。',
    // This is a JSON Schema document, not a parameter map. The registry passes
    // it straight through to the model API, and that API refuses a function
    // whose schema lacks `type: "object"` — a map-shaped `parameters` arrives
    // there as `type: null` and the whole session dies with
    // `Invalid schema for function 'read_figure'`. The reference tools in
    // `dsh-ops` (`lib/file/contract.js`) use exactly this shape.
    parameters: {
      type: 'object',
      properties: {
        imagePath: {
          type: 'string',
          description: '图片路径，绝对路径或相对当前工作目录。一次只给一张；多张请用 imagePaths。',
        },
        imagePaths: {
          type: 'array',
          items: { type: 'string' },
          description: '多张图片的路径列表，按你希望被描述的顺序给出；与 imagePath 二选一。',
        },
        label: {
          type: 'string',
          description: '题号或图名，例如「第 2 题」。会写进交接件标题，便于多图分别归档。',
        },
        problemText: {
          type: 'string',
          description:
            '强烈建议给出：题面文字（已知量数值、光滑/粗糙、轻绳轻滑轮等条件）。' +
            '图里永远看不到「5 kg」或「光滑」这类信息，而读交接件的人看不到题面，' +
            '所以不传这段文字，交接件就缺了读者最需要的一半。' +
            '传了它还会让视觉模型逐项核对图与文字是否冲突——冲突是最有价值的发现。',
        },
        question: {
          type: 'string',
          description:
            '定向追问。给出后本工具只回答这一条，不重写整份交接件。' +
            '问法要具体并给出两种可能读法，例如「m₂ 与 m₃ 谁更低？若读反了会怎样？」',
        },
        outPath: {
          type: 'string',
          description:
            '可选。把交接件同时写到这个文件（供人或后续会话复核）。' +
            '配置了 handoffDir 时，路径必须落在该目录内。',
        },
      },
      // imagePath / imagePaths are alternatives, so neither is required at the
      // schema level; `execute` rejects a call that gives neither, with a
      // message that names both. The keyword set here is deliberately identical
      // to `dsh-ops`' `bounded()` — `type`, `properties`, `required`,
      // `additionalProperties` — because those schemas are known to be accepted
      // by the endpoint this plugin calls.
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    // Declaration only: the registry does not enforce a deadline. It is set well
    // above the request timeout so the request's own, better-worded failure is
    // the one that surfaces.
    timeoutMs: config.timeoutMs + 30_000,
    execute: async (args, exec) => {
      const images = collectImages(args);
      if (!images.length) {
        throw new Error('read-figure: 请给 imagePath（单张）或 imagePaths（多张）');
      }
      // A path outside handoffDir is a caller mistake: reject it before the
      // vision call is paid for, not after.
      if (args.outPath) resolveHandoffPath(args.outPath, config);
      const result = await describeFigures({
        images,
        label: args.label,
        question: args.question,
        problemText: args.problemText,
        outPath: args.outPath,
        config,
        signal: exec?.signal,
      });
      return result.handoff;
    },
  };
}

function collectImages(args) {
  const list = [];
  if (Array.isArray(args.imagePaths)) list.push(...args.imagePaths);
  else if (typeof args.imagePaths === 'string' && args.imagePaths.trim()) list.push(args.imagePaths);
  if (typeof args.imagePath === 'string' && args.imagePath.trim()) list.unshift(args.imagePath);
  return [...new Set(list.map((s) => String(s).trim()).filter(Boolean))];
}

// The re-exported surface, which `lib/index.d.ts` declares and `tools/check.mjs`
// section 13 asserts against the runtime. `DEFAULTS` and the pixel helpers belong
// here because they are documented (README's "one source of truth for defaults")
// and because the type declaration promised them: a hand-written `.d.ts` that
// names an export the runtime does not have is worse than no types at all, since
// it compiles and then reads `undefined` at run time.
export {
  describeFigures,
  composeHandoff,
  finalizeHandoff,
  writeHandoff,
  resolveHandoffPath,
  normalizeConfig,
  resolveApiKey,
  readCredentialRefs,
  credentialCandidates,
  credentialsPath,
  defaults,
  DEFAULTS,
  describeImageSize,
  probeImage,
  decodeGray,
  decodeGrayPng,
  findSpecks,
  VisionError,
  EFFORTS,
};
export default { name, Config, inject, apply };
