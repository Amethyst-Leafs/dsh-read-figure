// Type declarations for read-figure.
//
// The implementation is plain ESM JavaScript; this file exists so a consumer
// (and the harness's own tooling) can see the shape without reading the source.
// It is hand-written and deliberately narrow: it describes what the module
// exports, not a private API.

/** Reasoning effort accepted by the vision endpoint. */
export type ReasoningEffort = 'low' | 'high' | 'max';

/** The Loader config. Every field is optional; unset fields fall back to DEFAULTS. */
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

/** A resolved config: defaults filled in. */
export type ResolvedReadFigureConfig = Required<ReadFigureConfig>;

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

export interface ScanResult {
  width: number;
  height: number;
  specks: SpeckRecord[];
  clipped: SpeckRecord[];
  dashRuns: unknown[];
  thresholds: Record<string, number>;
}

export interface ImageSizeInfo {
  format: string;
  width: number;
  height: number;
  bytes: number;
}

/**
 * `Config` is a Standard Schema, not a map of defaults.
 *
 * The Loader reads `Config['~standard'].validate(raw)`; it never inspects the
 * fields. Defaults live in `normalizeConfig`.
 */
export const Config: {
  '~standard': {
    version: 1;
    vendor: string;
    validate(raw: unknown): { value: ReadFigureConfig } | { issues: Array<{ message: string; path: Array<string | number> }> };
  };
  readonly fields: readonly string[];
};

export const name: 'read-figure';
export const inject: readonly ['tools'];

/** Mount the tool. Registers through a context effect; warns and does nothing when unusable. */
export function apply(ctx: unknown, config?: ReadFigureConfig): void;

/** The tool definition, exposed so a test can execute it without a live Loader. */
export function defineReadFigure(config: ResolvedReadFigureConfig): {
  name: 'read_figure';
  description: string;
  parameters: Record<string, unknown>;
  output: { schema: { type: 'string' }; render(args: unknown, value: string): Array<{ type: 'text'; text: string }> };
  timeoutMs: number;
  execute(args: Record<string, unknown>, exec?: { signal?: AbortSignal }): Promise<string>;
};

/** Fill defaults and validate. Throws a plain `Error` naming the offending field. */
export function normalizeConfig(raw?: ReadFigureConfig | null): ResolvedReadFigureConfig;
export function defaults(): ResolvedReadFigureConfig;

/** Resolve the API key: config, then READ_FIGURE_API_KEY, then DEEPSEEK_API_KEY, then the DSH credentials file. */
export function resolveApiKey(config: ReadFigureConfig, env?: Record<string, string | undefined>): { key: string; source: string };

/** Parse the flat `refs:` section of a credentials file. Returns `{}` when it cannot be read. */
export function readCredentialRefs(path: string): Record<string, string>;

/** The credentials-file paths that will be tried, in order. */
export function credentialCandidates(env?: Record<string, string | undefined>): string[];

/** Number and pixel dimensions of an image, read from its header. */
export function probeImage(path: string): ImageSizeInfo;

/** A one-line human description, e.g. `1536×2711px, 183 KB, jpeg`. */
export function describeImageSize(info: ImageSizeInfo): string;

/** Decode a JPEG or PNG into an 8-bit luminance plane. */
export function decodeGray(buffer: Buffer | Uint8Array): { width: number; height: number; data: Uint8Array };
export function decodeGrayPng(buffer: Buffer | Uint8Array): { width: number; height: number; data: Uint8Array };

/** Find stray ink marks, dash runs, and edge-clipped marks in a decoded page. */
export function findSpecks(
  image: { width: number; height: number; data: Uint8Array },
  options?: Record<string, number>,
): ScanResult;

export const EFFORTS: readonly ReasoningEffort[];
export const DEFAULTS: ResolvedReadFigureConfig;

declare const _default: { name: typeof name; Config: typeof Config; inject: typeof inject; apply: typeof apply };
export default _default;
