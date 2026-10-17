// Config resolution and validation for read-figure.
//
// The same normalizer serves the plugin row `config` and the CLI flags, so both
// surfaces can never drift. No field is inferred from a filesystem the caller
// did not name: an unavailable credential is an error with a fix, not a guess.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * The single source of truth for every default.
 *
 * `lib/index.mjs` builds its Loader `Config` schema from this object. A
 * hand-copied second copy already drifted once — the schema said
 * `maxTokens: 8000` while the normalizer said 32000 — which meant a user who
 * enabled the plugin with an empty `config` got precisely the setting that
 * produces an empty handoff. Anything a user may leave unset must be reachable
 * from here, and `tools/check.mjs` asserts the bundle row never restates one of
 * these with a different value.
 */
export const DEFAULTS = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  // A reasoning model spends output budget on its thinking chain before it emits
  // a single character of the handoff. Measured on a 3094x1526 scan at
  // effort=high: ~29k characters of reasoning and >8000 tokens to answer. An
  // 8000 default looked generous and actually produced an empty answer, so the
  // default is set above the observed ceiling rather than near it.
  maxTokens: 32000,
  reasoningEffort: 'high',
  timeoutMs: 180000,
  apiKey: '',
  promptFile: '',
  extraInstruction: '',
  handoffDir: '',
  writeHandoff: false,
};

// Credential environment names, in resolution order.
const KEY_ENV = ['READ_FIGURE_API_KEY', 'DEEPSEEK_API_KEY'];

export const EFFORTS = ['low', 'high', 'max'];

/**
 * Fill defaults and validate.
 *
 * Undefined values are dropped before merging: a partial-flag caller (the CLI)
 * naturally produces `{ model: undefined, … }`, and `String(undefined)` would
 * otherwise turn "not specified" into the literal string "undefined" — a bug
 * that only shows up on the one flag the user did not pass.
 */
export function normalizeConfig(raw = {}) {
  const given = {};
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) if (v !== undefined && v !== null) given[k] = v;
  }
  const c = { ...DEFAULTS, ...given };
  const out = {
    baseUrl: String(c.baseUrl).replace(/\/+$/, ''),
    model: String(c.model).trim(),
    maxTokens: toPositiveInt(c.maxTokens, DEFAULTS.maxTokens),
    reasoningEffort: String(c.reasoningEffort).trim().toLowerCase(),
    timeoutMs: toPositiveInt(c.timeoutMs, DEFAULTS.timeoutMs),
    apiKey: String(c.apiKey ?? '').trim(),
    promptFile: String(c.promptFile ?? '').trim(),
    extraInstruction: String(c.extraInstruction ?? ''),
    handoffDir: String(c.handoffDir ?? '').trim(),
    writeHandoff: c.writeHandoff === true || c.writeHandoff === 'true',
  };
  if (!out.model) throw new Error('read-figure: config.model 不能为空');
  if (!/^https?:\/\//.test(out.baseUrl)) {
    throw new Error(`read-figure: config.baseUrl 必须是 http(s) 的 URL，收到 ${JSON.stringify(c.baseUrl)}`);
  }
  if (out.reasoningEffort && !EFFORTS.includes(out.reasoningEffort)) {
    throw new Error(`read-figure: config.reasoningEffort 只能是 ${EFFORTS.join(' / ')}，收到 ${JSON.stringify(c.reasoningEffort)}`);
  }
  return out;
}

function toPositiveInt(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`read-figure: 期望正数，收到 ${JSON.stringify(v)}`);
  return Math.floor(n);
}

/**
 * Resolve the bearer token.
 *
 * Order: explicit config first, then the plugin's own environment name, then the
 * harness-wide `DEEPSEEK_API_KEY`, then that same name inside the harness
 * credential store. Config wins because a running harness cannot see a shell
 * variable exported after it started, so the config file is the only lever that
 * always works.
 *
 * Reading the credential store is what makes the plugin usable from a fresh
 * shell: dsh keeps `DEEPSEEK_API_KEY` in `.credentials.yaml` as a *ref*, it does
 * not export it to child processes, so without this step the CLI would work in
 * whichever shell happened to export the variable and nowhere else. The store is
 * read-only here and never written back.
 *
 * A missing key is reported with every place that was consulted, because a
 * silent 401 later is far more expensive than a loud failure now.
 */
export function resolveApiKey(config, env = process.env) {
  if (config?.apiKey) return { key: config.apiKey, source: 'config.apiKey' };
  for (const name of KEY_ENV) {
    const v = env?.[name];
    if (v && String(v).trim()) return { key: String(v).trim(), source: `env:${name}` };
  }
  const tried = credentialCandidates(env);
  for (const cand of tried) {
    const stored = readCredentialRefs(cand.path)[KEY_ENV[1]];
    if (stored) return { key: stored, source: `credentials:${cand.path}` };
  }
  throw new Error(
    'read-figure: 找不到视觉模型的 API Key。请任选一种方式：\n' +
      `  1) 在 cordis.patch.yml 的 read-figure 行里写 config.apiKey\n` +
      `  2) 设置环境变量 ${KEY_ENV[0]}\n` +
      `  3) 导出 ${KEY_ENV[1]}，或把它写进凭证库的 refs 段\n` +
      `已查过：${tried.map((c) => c.path).join('、')}\n` +
      '注意：运行中的 dsh 读不到你新设的 shell 变量时，请用方式 1。',
  );
}

/**
 * Read the `refs:` map out of the harness credential store.
 *
 * The store is a small YAML document whose `refs` section holds plain
 * `NAME: value` scalars. This parses only that flat section instead of pulling in
 * a YAML dependency: anything unparseable yields an empty map and the caller
 * reports a missing key with a fix, which is the outcome we want anyway.
 */
export function readCredentialRefs(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  const out = {};
  let inRefs = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (/^refs:\s*$/.test(line)) {
      inRefs = true;
      continue;
    }
    if (!inRefs) continue;
    if (!/^\s/.test(line)) break; // a new top-level key ends the section
    const m = /^\s+(?:(['"])([A-Za-z0-9_.-]+)\1|([A-Za-z0-9_.-]+))\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const name = m[2] ?? m[3];
    const value = m[4].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (value) out[name] = value;
  }
  return out;
}

/**
 * Candidate credential stores, in the order they are consulted.
 *
 * `DSH_HOME` is the authoritative answer but only dsh itself sets it: a plain
 * shell, a CI job, or any other child process sees it as unset, and then the
 * store lives in the conventional `.dsh` subdirectory instead. Returning every
 * candidate (rather than one guess) is what lets a script work both inside and
 * outside the harness, and lets the error message say exactly what was tried.
 */
export function credentialCandidates(env = process.env) {
  const out = [];
  const push = (path, why) => {
    if (path && !out.some((c) => c.path === path)) out.push({ path, why });
  };
  const home = env?.DSH_HOME || env?.USERPROFILE || env?.HOME || homedir();
  if (env?.DSH_HOME) push(join(env.DSH_HOME, '.credentials.yaml'), 'DSH_HOME');
  push(join(home, '.dsh', '.credentials.yaml'), '默认 dsh 目录');
  push(join(home, '.credentials.yaml'), '家目录');
  return out;
}

/** First candidate that exists — kept for callers that want one path to report. */
export function credentialsPath(env = process.env) {
  const cands = credentialCandidates(env);
  return cands[0]?.path ?? join(homedir(), '.dsh', '.credentials.yaml');
}

export function defaults() {
  return { ...DEFAULTS };
}
