// Type declarations for read-figure.
//
// The implementation is plain ESM JavaScript; this file exists so a consumer
// (and the harness's own tooling) can see the shape without reading the source.
//
// It is hand-written, and a hand-written declaration drifts. It drifted here in
// both directions at once: it promised `DEFAULTS`, `defaults`, `probeImage`,
// `decodeGray`, `decodeGrayPng` and `findSpecks` that `lib/index.mjs` did not
// re-export (so a TypeScript consumer would compile and then read `undefined`),
// and it silently omitted twelve exports that did exist. `tools/check.mjs`
// section 13 now asserts this file's `export` names against the live runtime
// export list, so a rename on either side fails the gate instead of shipping.

/** Reasoning effort accepted by the vision endpoint. */
export type ReasoningEffort = 'low' | 'high' | 'max';

/** The Loader config. Every field is optional; unset fields fall back to `DEFAULTS`. */
export interface ReadFigureConfig {
  /** OpenAI-compatible endpoint, without the `/chat/completions` suffix. Default `https://api.deepseek.com`. */
  baseUrl?: string;
  /** Model that will be asked to look at the image. Must accept image input. Default `deepseek-flash`. */
  model?: string;
  /** Inline API key. Takes precedence over environment variables and the credentials file. */
  apiKey?: string;
  /**
   * Output budget. The vision model spends this on its reasoning first, so a
   * small value returns an empty handoff rather than a shorter one. Default 32000.
   */
  maxTokens?: number;
  /** Reasoning effort. Lower values spend less of the budget thinking. Default `high`. */
  reasoningEffort?: ReasoningEffort;
  /** Per-request deadline in milliseconds. Default 180000. */
  timeoutMs?: number;
  /** Override the bundled handoff protocol. Default `prompts/figure-handoff.zh.md`. */
  promptFile?: string;
  /** Extra instruction appended to the protocol, for site-specific rules. */
  extraInstruction?: string;
  /** When set, `outPath` must resolve inside this directory. */
  handoffDir?: string;
  /** Write every handoff into `handoffDir` without being asked. Default false. */
  writeHandoff?: boolean;
}

/** A config with every default filled in. */
export type ResolvedReadFigureConfig = Required<ReadFigureConfig>;

/**
 * `Config` is a Standard Schema, not a map of defaults.
 *
 * The Loader reads `Config['~standard'].validate(raw)` and never inspects the
 * fields; the harness threw `TypeError: Cannot read properties of undefined
 * (reading 'validate')` when this was anything else. Unknown keys are dropped by
 * `validate`, and the field list stays in step with `DEFAULTS` by construction.
 */
export const Config: {
  '~standard': {
    version: 1;
    vendor: string;
    validate(raw: unknown): { value: ReadFigureConfig } | { issues: Array<{ message: string; path: Array<string | number> }> };
  };
  readonly fields: readonly string[];
};

/**
 * The shape the model API insists on for a function's arguments: a JSON Schema
 * document. `type` here is not decorative — a schema without it is serialized
 * as `type: null` and the API refuses the whole request.
 */
export interface ToolParametersSchema {
  type: 'object';
  description?: string;
  properties: Record<string, { type: string; description?: string; items?: { type: string } }>;
  required?: readonly string[];
  additionalProperties: false;
}

export const name: 'read-figure';
/** Only `tools` is injected; the optional credential service stays out of the hard list. */
export const inject: readonly string[];

/** Mount the tool. Registers through a context effect; warns and does nothing when unusable. */
export function apply(ctx: unknown, config?: ReadFigureConfig): void;

/** Runtime config defaults: the single source `Config` and the docs are generated from. */
export const DEFAULTS: ReadFigureConfig;

/** The reasoning efforts the endpoint accepts, in escalation order. */
export const EFFORTS: readonly ReasoningEffort[];

/** Fill defaults and validate. Throws a plain `Error` naming the offending field. */
export function normalizeConfig(raw?: ReadFigureConfig | null): ResolvedReadFigureConfig;
/** The defaults as a fresh mutable object. */
export function defaults(): ResolvedReadFigureConfig;

/** The tool definition, exposed so a test can execute it without a live Loader. */
export function defineReadFigure(config: ResolvedReadFigureConfig): {
  name: 'read_figure';
  description: string;
  /**
   * A JSON Schema document whose own `type` is `"object"` — the model API
   * rejects the function otherwise (`type: null` for a parameter map). This is
   * `Record<string, unknown>` in the old declarations, which is how a map
   * shaped by hand could pass type-checking and still fail at request time.
   */
  parameters: ToolParametersSchema;
  output: {
    schema: { type: 'string' };
    /** One text part — the agent reads it directly rather than through a file. */
    render(args: Record<string, unknown>, value: string): Array<{ type: 'text'; text: string }>;
  };
  timeoutMs: number;
  execute(
    args: {
      imagePath?: string;
      imagePaths?: string | string[];
      label?: string;
      question?: string;
      outPath?: string;
      write?: boolean;
    },
    exec?: { signal?: AbortSignal },
  ): Promise<string>;
};

/** What one vision round trip recorded about itself, so the handoff is auditable. */
export interface Provenance {
  /** API model id, default `deepseek-flash`. */
  model: string;
  baseUrl: string;
  /** Absolute path of the protocol file that shaped the request. */
  protocolFile: string;
  /** Where the API key came from: `explicit`, an `env:NAME` tag, or the credentials file. */
  keySource: string;
  effort: ReasoningEffort | null;
  /** `stop` or `length`; `length` means the handoff was cut off mid-sentence. */
  finish: string | null;
  seconds: number;
  usage: Record<string, unknown> | null;
  reasoningChars: number;
  images: Array<{ path: string; name: string; width: number; height: number; bytes: number; format: string }>;
  /** The caller's label, collapsed to one string when only one was given. */
  label: string | string[];
  /** Echoes back the question this run asked, or null for a first pass. */
  question: string | null;
  generatedAt: string;
}

/**
 * One full vision round trip.
 *
 * `handoff` is the markdown meant for a text-only model; `answer` is the raw
 * vision text it was assembled from, kept separately so a caller can tell an
 * awkward handoff from an awkward model. Read `provenance.finish`: a handoff
 * truncated by `finish=length` and a completed one read identically.
 */
export function describeFigures(input: {
  images: string | string[];
  question?: string;
  label?: string | string[];
  /** Statement text to transcribe alongside the figure and cross-check against it. */
  problemText?: string;
  apiKey?: string;
  config?: ReadFigureConfig;
  signal?: AbortSignal;
  /** When set, the handoff is also written here, through `writeHandoff`. */
  outPath?: string;
}): Promise<{
  handoff: string;
  answer: string;
  provenance: Provenance;
  protocol: string;
  /** The user turn actually sent, so a surprising result can be traced to its prompt. */
  request: string;
  /** Present only when `outPath` was given. */
  outPath?: string;
}>;

/** Assemble the exact markdown a text-only model is meant to read. */
export function composeHandoff(input: {
  question?: string;
  answer: string;
  labels: string[];
  imageInfo: Array<{ path: string; width: number; height: number; bytes: number }>;
  provenance: Provenance;
}): string;

/** Insert the provenance line into a handoff, so cost and stop reason stay auditable. */
export function finalizeHandoff(text: string, provenance: Provenance): string;

/** Resolve `outPath` to an absolute path, refusing anything outside `config.handoffDir`. */
export function resolveHandoffPath(outPath: string, config?: Pick<ReadFigureConfig, 'handoffDir'>): string;

/** Write a handoff file, creating parent directories. */
export function writeHandoff(
  outPath: string,
  text: string,
  config?: Pick<ReadFigureConfig, 'handoffDir'>,
): { path: string; bytes: number };

/** Resolve the API key: config, then READ_FIGURE_API_KEY, then DEEPSEEK_API_KEY, then the DSH credentials file. */
export function resolveApiKey(
  config: ReadFigureConfig,
  env?: Record<string, string | undefined>,
): { key: string; source: string };

/** Parse the flat `refs:` section of a credentials file. Returns `{}` when it cannot be read. */
export function readCredentialRefs(path: string): Record<string, string>;

/** The credentials-file paths that will be tried, in order. */
export function credentialCandidates(env?: Record<string, string | undefined>): string[];
/** The credentials file that exists, or would be used, for this environment. */
export function credentialsPath(env?: Record<string, string | undefined>): string;

/** Number and pixel dimensions of an image, read from its header. */
export function probeImage(path: string): ImageSizeInfo;
export interface ImageSizeInfo {
  format: string;
  width: number;
  height: number;
  bytes: number;
}
/** A one-line human description, e.g. `1536×2711px, 183 KB, jpeg`. */
export function describeImageSize(info: ImageSizeInfo): string;

/** Decode a JPEG or PNG into an 8-bit luminance plane. Throws `DecodeError`. */
export function decodeGray(buffer: Buffer | Uint8Array, options?: Record<string, unknown>): {
  width: number;
  height: number;
  data: Uint8Array;
};
export function decodeGrayPng(buffer: Buffer | Uint8Array): {
  width: number;
  height: number;
  data: Uint8Array;
};

/** One thing the mechanical pixel scan found. Coordinates are absolute pixels. */
export interface SpeckRecord {
  area: number;
  width: number;
  height: number;
  x: number;
  y: number;
  bbox: [number, number, number, number];
  zone: string;
  fill: number;
  normX: number;
  normY: number;
  peakInk: number;
  paperLevel: number;
  contrast: number;
}

/** A run of short, evenly spaced marks — a dashed line, not a stray dot. */
export interface DashRun {
  members: SpeckRecord[];
  vertical: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScanResult {
  width: number;
  height: number;
  componentCount: number;
  bigCount: number;
  inkTotal: number;
  bigInk: number;
  /** Free-standing marks: the scan's actual output. */
  specks: SpeckRecord[];
  /** Groups of marks that a dashed line explains, so they are not reported as specks. */
  dashRuns: DashRun[];
  /** Marks touching the page edge, where a cut-off shape cannot be judged. */
  clipped: SpeckRecord[];
  /** Low-contrast marks, below the ink threshold. */
  faint: SpeckRecord[];
  /** Large hollow rings — bubbles and glyph bowls. */
  hollow: SpeckRecord[];
  thresholds: Record<string, number>;
}

/** Find stray ink marks, dash runs, and edge-clipped marks in a decoded page. */
export function findSpecks(
  image: { width: number; height: number; data: Uint8Array },
  options?: Record<string, number>,
): ScanResult;

/** Thrown when the vision endpoint fails; carries the HTTP status when there was one. */
export class VisionError extends Error {
  constructor(message: string, options?: { code?: string; status?: number; body?: string });
  readonly code: string;
  readonly status?: number;
  readonly body?: string;
}

declare const _default: {
  name: typeof name;
  Config: typeof Config;
  inject: typeof inject;
  apply: typeof apply;
};
export default _default;
