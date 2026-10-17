#!/usr/bin/env node
// Offline contract checks for read-figure.
//
// These are the assertions that were worth having exactly once, so they live in
// the published package instead of a scratch file: the manifest fields the
// Harness and the marketplace actually read, the exported plugin surface, and —
// most importantly — the tool executed end to end against a local stub. The stub
// matters because "the plugin registers" and "the tool works" are different
// claims, and only the second one exercises argument collection, image probing,
// the request body, and the assembled text.
//
//   node tools/check.mjs

import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve as resolvePath } from 'node:path';

import * as plugin from '../lib/index.mjs';
import { probeImage, describeImageSize } from '../lib/image-size.mjs';
import { figurePaths, describeFixtures } from './fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolvePath(HERE, '..');

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    process.stdout.write(`  ✔ ${name}${detail ? ` — ${detail}` : ''}\n`);
  } else {
    fail++;
    process.stdout.write(`  ✘ ${name}${detail ? ` — ${detail}` : ''}\n`);
  }
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}`);

process.stdout.write('read-figure 契约自检\n\n');

// ── 1. manifest ────────────────────────────────────────────────────────────
process.stdout.write('1. package.json / 插件清单\n');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
ok('name 是合法 npm 包名', /^[a-z0-9][a-z0-9._-]*$/.test(pkg.name), pkg.name);
ok('version 是 semver', /^\d+\.\d+\.\d+/.test(pkg.version), pkg.version);
ok('type 是 module', pkg.type === 'module');
ok('description 非空且非模板残留', typeof pkg.description === 'string' && pkg.description.length > 20 && !/TODO|占位/.test(pkg.description));
ok('dsh.bundle.patch 指向存在的文件', typeof pkg.dsh?.bundle?.patch === 'string' && existsSync(join(ROOT, pkg.dsh.bundle.patch)), pkg.dsh?.bundle?.patch);
// exports["."] may be a bare string or a conditions map; both are valid, and the
// string form is what the plugin Loader's own resolution accepts. Normalise to
// the runtime target so the manifest cross-check below compares like with like.
const exportEntry = pkg.exports?.['.'];
const entry = typeof exportEntry === 'string' ? exportEntry : exportEntry?.default;
ok('exports["."] 存在', typeof entry === 'string' && existsSync(join(ROOT, entry)), JSON.stringify(exportEntry));
ok(
  'exports["."] 的 default 与 types 并存时 types 指向存在的文件',
  typeof exportEntry !== 'object' || !exportEntry.types || existsSync(join(ROOT, exportEntry.types)),
  typeof exportEntry === 'object' ? String(exportEntry.types) : 'n/a',
);
for (const f of pkg.files ?? []) {
  ok(`files 里的 ${f} 确实存在`, existsSync(join(ROOT, f.replace(/\/$/, ''))));
}
const bin = pkg.bin?.['read-figure'];
ok('bin.read-figure 存在', typeof bin === 'string' && existsSync(join(ROOT, bin)), bin);

// ── 2. bundle patch ────────────────────────────────────────────────────────
process.stdout.write('\n2. cordis.patch.yml\n');
const patchText = readFileSync(join(ROOT, pkg.dsh.bundle.patch), 'utf8');
// The patch is Loader YAML, so it is checked with the real YAML parser rather
// than a regex: a syntax error here is a plugin that never mounts.
let patch;
try {
  patch = parseYamlText(patchText);
} catch (err) {
  patch = null;
  ok('patch 是合法 YAML', false, err.message);
}
ok('patch 是合法 YAML', patch !== null);
const rows = Array.isArray(patch) ? patch[0]?.insert : undefined;
ok('patch 顶层是含 insert 的列表', Array.isArray(rows) && rows.length >= 1);
const row = rows?.[0] ?? {};
ok('insert 的行 id 与包名一致', row.id === pkg.name, `id=${row.id} name=${row.name}`);
ok('行 name 指向本包', row.name === pkg.name || row.name === undefined);
ok('行 config 里每个键都是 Config 声明的字段', Object.keys(row.config ?? {}).every((k) => plugin.Config.fields.includes(k)), Object.keys(row.config ?? {}).join(','));

// A row value that disagrees with DEFAULTS is a silent trap: the row wins, the
// user never sees the other number, and the symptom is a broken result rather
// than an error. This exact bug shipped once (`maxTokens: 8000` in the row,
// 32000 in DEFAULTS), and it made every fresh install return an empty handoff.
// Assert the two agree rather than trusting that they do.
{
  const { DEFAULTS } = await import('../lib/config.mjs');
  const disagreeing = Object.entries(row.config ?? {}).filter(
    ([k, v]) => k in DEFAULTS && String(v) !== String(DEFAULTS[k]),
  );
  ok(
    '行 config 里没有与 DEFAULTS 相冲突的值',
    disagreeing.length === 0,
    disagreeing.length ? disagreeing.map(([k, v]) => `${k}: 行=${v} 缺省=${DEFAULTS[k]}`).join('; ') : '全部一致',
  );
  // And the schema must not carry a second copy of the defaults. It deliberately
  // returns the raw config untouched so `normalizeConfig` stays the only thing
  // that fills them; if a default ever reappears here, the two sources can drift
  // apart again exactly the way they did before.
  eq(
    'Config 的字段集与 DEFAULTS 完全一致',
    [...plugin.Config.fields].sort(),
    Object.keys(DEFAULTS).sort(),
  );
  const applied = plugin.Config['~standard'].validate({});
  eq('空 config 通过校验，且不回填任何缺省值', applied.value, {});
  ok('空 config 校验无 issue', applied.issues === undefined, JSON.stringify(applied.issues));
}

// ── 3. exported surface ────────────────────────────────────────────────────
process.stdout.write('\n3. 导出的插件接口\n');
ok('导出 name', plugin.name === pkg.name);
ok('导出 Config', typeof plugin.Config === 'object' && Object.keys(plugin.Config).length > 0);
ok('导出 apply 函数', typeof plugin.apply === 'function');
ok('inject 是字符串数组且不含可选服务', Array.isArray(plugin.inject) && plugin.inject.every((s) => typeof s === 'string'), plugin.inject?.join(','));
ok('inject 只声明 tools', JSON.stringify(plugin.inject) === JSON.stringify(['tools']));
ok('default 导出带 name/Config/apply', plugin.default?.name === pkg.name && typeof plugin.default?.apply === 'function');

// ── 3b. Config 是 Standard Schema（这是真的会让插件起不来的那一处） ─────────
//
// The Loader never reads Config as data: cordis `resolveConfig` calls
// `runtime.Config['~standard'].validate(rawConfig)`. A plain map of field
// descriptors passed every offline test this suite had and still refused to
// activate in a live profile, with
//   TypeError: Cannot read properties of undefined (reading 'validate')
// so the interface itself is asserted here, not the values it returns.
process.stdout.write('\n3b. Config 的 Standard Schema 接口\n');
{
  const std = plugin.Config['~standard'];
  ok('Config["~standard"] 存在', typeof std === 'object' && std !== null);
  eq('~standard.version 是 1', std?.version, 1);
  ok('~standard.vendor 是非空字符串', typeof std?.vendor === 'string' && std.vendor.length > 0, String(std?.vendor));
  ok('~standard.validate 是函数', typeof std?.validate === 'function');

  // A throwing validate is worse than a missing one: it fails activation with a
  // stack trace from inside the Loader instead of naming the offending field.
  const bad = plugin.Config['~standard'].validate({ maxTokens: 'lots' });
  ok('非法输入返回 issues 而不是抛异常', Array.isArray(bad.issues) && bad.issues.length > 0, JSON.stringify(bad.issues));
  ok('issue 带 message 与 path', typeof bad.issues[0]?.message === 'string' && Array.isArray(bad.issues[0]?.path), JSON.stringify(bad.issues[0]));

  const unknown = plugin.Config['~standard'].validate({ baseUrl: 'https://example.com', maxTokes: 100 });
  ok('未知字段被报错（拼错一个键不能静默失效）', Array.isArray(unknown.issues) && unknown.issues.some((i) => i.path?.[0] === 'maxTokes'), JSON.stringify(unknown.issues));

  const badEffort = plugin.Config['~standard'].validate({ reasoningEffort: 'medium' });
  ok('reasoningEffort 只接受 low/high/max', Array.isArray(badEffort.issues) && badEffort.issues.length === 1, JSON.stringify(badEffort.issues));

  ok('baseUrl 拒绝非 URL', Array.isArray(plugin.Config['~standard'].validate({ baseUrl: 'not a url' }).issues));
  ok('baseUrl 拒绝非 http(s) 协议', Array.isArray(plugin.Config['~standard'].validate({ baseUrl: 'ftp://example.com' }).issues));
  ok('baseUrl 接受 http 与 https', !plugin.Config['~standard'].validate({ baseUrl: 'http://127.0.0.1:8080' }).issues);

  ok('config 是数组时被拒', Array.isArray(plugin.Config['~standard'].validate([]).issues));
  ok('config 是字符串时被拒', Array.isArray(plugin.Config['~standard'].validate('nope').issues));
  ok('config 是 null 时按空对象处理', !plugin.Config['~standard'].validate(null).issues);

  // Zero would be "valid" to a plain integer check and would then ask the API for
  // a zero-token completion, which returns an empty body — the exact symptom the
  // READ_FIGURE_EMPTY guard exists to explain.
  const zero = plugin.Config['~standard'].validate({ maxTokens: 0 });
  ok('maxTokens 拒绝 0', Array.isArray(zero.issues), JSON.stringify(zero.issues));
  ok('timeoutMs 拒绝小数', Array.isArray(plugin.Config['~standard'].validate({ timeoutMs: 1.5 }).issues));
  ok('writeHandoff 只接受布尔值', Array.isArray(plugin.Config['~standard'].validate({ writeHandoff: 'yes' }).issues));

  // Every accepted value must still survive the normalizer: the schema and the
  // normalizer are two gates on one path, and a value that clears the first and
  // trips the second is a config a user cannot write down correctly.
  const accepted = plugin.Config['~standard'].validate({
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    apiKey: 'sk-test',
    maxTokens: 32000,
    reasoningEffort: 'high',
    timeoutMs: 180000,
    promptFile: '/tmp/p.md',
    extraInstruction: '补充一句',
    handoffDir: '/tmp/handoff',
    writeHandoff: false,
  });
  ok('一份完整的合法 config 通过校验', !accepted.issues, JSON.stringify(accepted.issues));
  let normalizedThroughBoth = null;
  try {
    normalizedThroughBoth = plugin.normalizeConfig(accepted.value);
  } catch (err) {
    normalizedThroughBoth = err;
  }
  ok('通过 schema 的值也通过 normalizeConfig', normalizedThroughBoth instanceof Error === false, String(normalizedThroughBoth));
}
// Regression: a partial-flag caller (the CLI) passes undefined for every flag it
// was not given. Those must fall back to defaults, not become the string
// "undefined".
const partial = plugin.normalizeConfig({ baseUrl: undefined, model: undefined, apiKey: undefined, maxTokens: undefined });
ok('未给的字段回落缺省而不是 "undefined"', partial.baseUrl === 'https://api.deepseek.com' && partial.model === 'deepseek-flash', partial.baseUrl);

// ── 4. defineReadFigure 的形状 ─────────────────────────────────────────────
process.stdout.write('\n4. 工具定义\n');
const def = plugin.defineReadFigure(plugin.normalizeConfig({}));
ok('工具名是 read_figure', def.name === 'read_figure');
ok('description 提到「识图交接件」', def.description.includes('识图交接件'));
ok('description 说明了追问用法', def.description.includes('question'));
// The model API validates the function schema itself, and it is unforgiving
// about exactly one thing: the schema's own type must be the string "object".
// A parameter *map* (name -> {type, required}) reaches it as `type: null` and
// kills the whole session with `Invalid schema for function 'read_figure'`.
// The registry does not check this, so the API is the only thing that ever
// would — at request time, in a live session. This is the offline stand-in.
// (The reference tools in `dsh-ops` build the same shape with `bounded()`.)
const JSON_SCHEMA_TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'];
const TOOL_PARAMS = ['imagePath', 'imagePaths', 'label', 'outPath', 'problemText', 'question'];
function checkToolParameters(schema, prefix = 'parameters') {
  const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  ok(`${prefix} 是对象`, isPlainObject(schema));
  eq(`${prefix}.type 必须是 "object"（否则模型 API 拒收）`, schema?.type, 'object');
  ok(`${prefix}.properties 是对象`, isPlainObject(schema?.properties));
  const names = Object.keys(schema?.properties ?? {});
  ok(`${prefix}.properties 覆盖 6 个入参`, names.length === TOOL_PARAMS.length && TOOL_PARAMS.every((n) => n in (schema?.properties ?? {})), names.join(','));
  for (const name of names) {
    const prop = schema.properties[name] ?? {};
    ok(`${prefix}.properties.${name} 声明了合法 type`, JSON_SCHEMA_TYPES.includes(prop.type), String(prop.type));
    ok(`${prefix}.properties.${name} 有说明文字`, typeof prop.description === 'string' && prop.description.length > 0);
    // A `required: true` inside a property is the signature of the old map
    // form: legal JSON, meaningless as a JSON Schema keyword, and it silently
    // moves the requirement out of `required` where the model would see it.
    ok(`${prefix}.properties.${name} 没有把 required 写在属性里`, !('required' in prop), JSON.stringify(prop.required));
    if (prop.type === 'array') ok(`${prefix}.properties.${name}.items 有 type`, JSON_SCHEMA_TYPES.includes(prop.items?.type), String(prop.items?.type));
  }
  if ('required' in (schema ?? {})) {
    ok(`${prefix}.required 是数组`, Array.isArray(schema.required));
    ok(`${prefix}.required 里的名字都真的存在`, (schema.required ?? []).every((n) => names.includes(n)), JSON.stringify(schema.required));
  }
  eq(`${prefix}.additionalProperties 为 false`, schema?.additionalProperties, false);
  // What travels over the wire is the JSON-serialized form: an undefined
  // property or a function value would silently vanish there, not here.
  const wire = JSON.parse(JSON.stringify(schema ?? null));
  eq(`${prefix} 经 JSON 序列化后 type 仍是 "object"`, wire?.type, 'object');
  ok(`${prefix} 经 JSON 序列化后属性数不变`, Object.keys(wire?.properties ?? {}).length === names.length, `${Object.keys(wire?.properties ?? {}).length} vs ${names.length}`);
}

checkToolParameters(def.parameters);
ok('output.schema 声明为 string', def.output?.schema?.type === 'string');
const rendered = def.output.render({}, 'hello');
ok('output.render 返回文本块数组', Array.isArray(rendered) && rendered[0]?.type === 'text' && rendered[0]?.text === 'hello');
ok('execute 是函数', typeof def.execute === 'function');
ok('execute 声明自己的超时（大于请求超时）', def.timeoutMs > plugin.normalizeConfig({}).timeoutMs);

// ── 5. 真实图片头解析 ──────────────────────────────────────────────────────
process.stdout.write('\n5. 图片头解析\n');
{
  const expected = [
    ['1.jpg', [1536, 2711]],
    ['2.jpg', [3094, 1526]],
  ];
  const dir = figurePaths()?.dir;
  if (!dir) {
    process.stdout.write(`  · 跳过（${describeFixtures()}）\n`);
  } else {
    for (const [name, [w, h]] of expected) {
      const p = join(dir, name);
      if (!existsSync(p)) {
        process.stdout.write(`  · 跳过 ${name}\n`);
        continue;
      }
      const info = probeImage(p);
      // Pinning the exact dimensions matters: they are what the mechanised scan
      // scales its thresholds against, so a header parser that misreads them
      // silently retunes the speck detector.
      eq(`解析 ${name}`, [info.width, info.height], [w, h]);
      ok(`描述 ${name}`, describeImageSize(info).includes('px'), describeImageSize(info));
    }
  }
}

// ── 6. 端到端：对着本地桩服务真跑一次 execute ──────────────────────────────
process.stdout.write('\n6. 端到端（本地桩服务，不联网）\n');
const stubAnswer = [
  '## 第 1 题',
  '',
  '### 一、图的结构（逐项描述）',
  '桩：天花板阴影线下方有倒三角吊架，吊着大圆 A。',
  '',
  '### 二、复述',
  '桩：绳一段吊 m₁。',
  '',
  '### 三、⚠ 读图置信度声明',
  '- **高置信**：A 是定滑轮。',
  '- **不确定**：右上角有一个约 6×10 像素的游离小黑点，判为扫描件噪点。**若纯文本模型看到本条，请勿据此引入额外质点或铰点。**',
].join('\n');

let seenBody = null;
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    seenBody = { url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: stubAnswer, reasoning_content: '桩思考' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }),
    );
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// A real scan when one is available (it exercises the JPEG decoder on a genuine
// 4:2:2 entropy stream); a synthesised PNG otherwise, so the end-to-end section
// runs even in a checkout without the borrowed figures.
const fixtureSet = figurePaths();
const figure = fixtureSet ? fixtureSet.fig2 : null;
const fakeImage = figure ?? makeTinyPng();

try {
  const stubConfig = plugin.normalizeConfig({
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: 'stub-key',
    maxTokens: 1234,
    reasoningEffort: 'low',
    // Deliberately narrower than the package root: the end-to-end run proves the
    // guard is armed, and the error-path block below proves it bites.
    handoffDir: join(ROOT, 'tools'),
  });
  const stubDef = plugin.defineReadFigure(stubConfig);
  const text = await stubDef.execute({ imagePath: fakeImage, label: '第 1 题' }, {});

  ok('桩服务收到了 /chat/completions', seenBody?.url === '/chat/completions', String(seenBody?.url));
  ok('Authorization 头是 Bearer', seenBody?.auth === 'Bearer stub-key');
  eq('请求体里 model 正确', seenBody?.body.model, 'deepseek-flash');
  eq('max_tokens 透传', seenBody?.body.max_tokens, 1234);
  eq('reasoning_effort 透传', seenBody?.body.reasoning_effort, 'low');
  eq('messages 是 system + user', seenBody?.body.messages?.map((m) => m.role), ['system', 'user']);
  ok('system 消息是协议全文', seenBody?.body.messages?.[0]?.content?.includes('三、⚠ 读图置信度声明'));
  const parts = seenBody?.body.messages?.[1]?.content ?? [];
  ok('user 消息是内容块数组', Array.isArray(parts));
  ok('第一个块是文本', parts[0]?.type === 'text' && typeof parts[0]?.text === 'string');
  const imgPart = parts.find((p) => p.type === 'image_url');
  ok('图片以 data URL 传入', typeof imgPart?.image_url?.url === 'string' && imgPart.image_url.url.startsWith('data:image/'));
  ok('data URL 是 base64 且非空', /;base64,[A-Za-z0-9+/=]{16,}$/.test(imgPart?.image_url?.url ?? ''));

  ok('返回值是三段式交接件', text.includes('# 识图交接件 · 第 1 题') && text.includes('一、图的结构') && text.includes('三、⚠ 读图置信度声明'));
  ok('返回值附带执行说明', text.includes('给纯文本模型的执行说明'));
  ok('返回值声明不含解答', text.includes('本文件不含任何解答'));
  ok('返回值保留噪点防护句', text.includes('请勿据此引入额外质点或铰点'));
  ok('返回值带本次调用出处（时长/停止原因/tokens）', /本次调用：.*2\d\.\d s|本次调用：.*finish=stop/.test(text) && text.includes('finish=stop'), (text.match(/本次调用：.*/) ?? [''])[0].slice(0, 90));
  ok('出处行里没有留下空槽', !text.includes('<!--read-figure'));

  process.stdout.write('\n7. 题面文字透传\n');
  let seenProblem = null;
  const problemServer = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seenProblem = JSON.parse(raw);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: stubAnswer }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise((r) => problemServer.listen(0, '127.0.0.1', r));
  try {
    const cfg = plugin.normalizeConfig({ baseUrl: `http://127.0.0.1:${problemServer.address().port}`, apiKey: 'k' });
    await plugin
      .defineReadFigure(cfg)
      .execute({ imagePath: fakeImage, label: '第 1 题', problemText: '定滑轮 A 一方挂有 m₁ = 5 kg 的物体；绳不可伸长，滑轮轻质。' }, {});
    const userText = seenProblem?.messages?.[1]?.content?.find((p) => p.type === 'text')?.text ?? '';
    ok('题面文字进入请求', userText.includes('m₁ = 5 kg') && userText.includes('绳不可伸长'));
    ok('请求要求核对图与文字是否冲突', userText.includes('冲突'));
  } finally {
    problemServer.close();
  }

  process.stdout.write('\n8. 出错路径\n');
  // A caller-cancelled turn must not look like a successful empty handoff.
  const aborted = new AbortController();
  aborted.abort();
  try {
    await plugin.defineReadFigure(stubConfig).execute({ imagePath: fakeImage }, { signal: aborted.signal });
    ok('已取消的信号会抛错', false, '竟然成功了');
  } catch (err) {
    ok('已取消的信号会抛错', err?.name === 'VisionError' || err?.code === 'READ_FIGURE_ABORTED', `${err?.name}:${err?.code}`);
  }
  try {
    await plugin.defineReadFigure(stubConfig).execute({}, {});
    ok('两张都不给时报错', false);
  } catch (err) {
    ok('两张都不给时报错', /imagePath/.test(err.message));
  }
  try {
    await plugin.defineReadFigure(stubConfig).execute({ imagePath: join(ROOT, 'package.json') }, {});
    ok('非图片文件被拒', false);
  } catch (err) {
    ok('非图片文件被拒', /不是可识别的/.test(err.message));
  }
  try {
    await plugin.defineReadFigure(stubConfig).execute({ imagePath: fakeImage, outPath: join(ROOT, 'escaped.md') }, {});
    ok('handoffDir 外的 outPath 被拒', false);
  } catch (err) {
    ok('handoffDir 外的 outPath 被拒', /拒绝写到/.test(err.message), err.message.slice(0, 60));
  }
} finally {
  server.close();
}

// ── 9. 密钥解析（含从凭证库兜底） ───────────────────────────────────────────
// Regression guard: the CLI used to work only in a shell that happened to export
// DEEPSEEK_API_KEY, while the error message told the user to take the key out of
// the credential store. The store is what makes a fresh shell work, so it is
// asserted here rather than trusted.
process.stdout.write('\n9. 密钥解析\n');
const credHome = mkdtempSync(join(tmpdir(), 'read-figure-creds-'));
const credFile = join(credHome, '.credentials.yaml');
writeFileSync(
  credFile,
  [
    'version: 1',
    'records:',
    '  deepseek-account-platform/default:',
    '    kind: grant',
    '    payload:',
    '      token: NOT-A-KEY',
    'refs:',
    '  DEEPSEEK_API_KEY: sk-from-store',
    '  QUOTED_KEY: "sk-quoted"',
    '  "BRACKETED": sk-bracket',
    'other: 1',
    '  DEEPSEEK_API_KEY: sk-after-section',
    '',
  ].join('\n'),
  'utf8',
);
const noEnv = { DSH_HOME: credHome };
const refs = plugin.readCredentialRefs(credFile);
eq('凭证库 refs 段被解析', Object.keys(refs).sort(), ['BRACKETED', 'DEEPSEEK_API_KEY', 'QUOTED_KEY']);
eq('未加引号的值原样保留', refs.DEEPSEEK_API_KEY, 'sk-from-store');
eq('配对引号被剥掉', refs.QUOTED_KEY, 'sk-quoted');
eq('带引号的键名也被接受', refs.BRACKETED, 'sk-bracket');
ok('下一个顶层键结束 refs 段', refs.DEEPSEEK_API_KEY !== 'sk-after-section', refs.DEEPSEEK_API_KEY);
eq('凭证库不存在时返回空表', plugin.readCredentialRefs(join(credHome, 'nope.yaml')), {});
eq(
  'config.apiKey 优先于一切',
  plugin.resolveApiKey({ apiKey: 'sk-cfg' }, { DSH_HOME: credHome, DEEPSEEK_API_KEY: 'sk-env' }).source,
  'config.apiKey',
);
eq(
  '环境变量优先于凭证库',
  plugin.resolveApiKey({}, { DSH_HOME: credHome, DEEPSEEK_API_KEY: 'sk-env' }).source,
  'env:DEEPSEEK_API_KEY',
);
const fromStore = plugin.resolveApiKey({}, noEnv);
eq('全新 shell 里回落到凭证库', fromStore.key, 'sk-from-store');
ok('并且出处如实标注', fromStore.source === `credentials:${credFile}`, fromStore.source);

// A bare shell (no DSH_HOME) must still find the conventional ~/.dsh store.
const bareHome = mkdtempSync(join(tmpdir(), 'read-figure-bare-'));
mkdirSync(join(bareHome, '.dsh'), { recursive: true });
const bareStore = join(bareHome, '.dsh', '.credentials.yaml');
writeFileSync(bareStore, 'refs:\n  DEEPSEEK_API_KEY: sk-bare\n', 'utf8');
const bare = plugin.resolveApiKey({}, { USERPROFILE: bareHome, HOME: bareHome });
eq('没有 DSH_HOME 时找 ~/.dsh/.credentials.yaml', bare.key, 'sk-bare');
ok('出处写明是哪一个文件', bare.source === `credentials:${bareStore}`, bare.source);
const cands = plugin.credentialCandidates({ USERPROFILE: bareHome });
ok('候选表不重复', new Set(cands.map((c) => c.path)).size === cands.length, `${cands.length} 个`);
rmSync(bareHome, { recursive: true, force: true });

try {
  plugin.resolveApiKey({}, { DSH_HOME: join(credHome, 'empty-home'), USERPROFILE: join(credHome, 'empty-home') });
  ok('凭证库也没有时抛出可操作的错误', false);
} catch (err) {
  ok('凭证库也没有时抛出可操作的错误', /找不到视觉模型的 API Key/.test(err.message));
  ok('错误里列出三种补救方式', /config\.apiKey/.test(err.message) && /READ_FIGURE_API_KEY/.test(err.message));
  ok('错误里列出已查过的路径', /已查过：/.test(err.message) && err.message.includes('empty-home'));
}
rmSync(credHome, { recursive: true, force: true });

// The summary is deliberately the last statement in the file. When it sat
// earlier, a later section's failures were counted into `pass`/`fail` only
// after the exit code had already been decided, so a broken section could
// report green.

// ── helpers ────────────────────────────────────────────────────────────────
function makeTinyPng() {
  // A 2x2 white PNG, so the end-to-end check never depends on an image outside
  // the package. It goes in the OS temp directory rather than next to this
  // script: a fixture that writes into a tracked directory turns a passing run
  // into a dirty working tree.
  const b64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8DAwMDAxMDAwMAAAA0BAQDJ/pLvAAAAAElFTkSuQmCC';
  const dir = mkdtempSync(join(tmpdir(), 'read-figure-png-'));
  const target = join(dir, 'tiny.png');
  writeFileSync(target, Buffer.from(b64, 'base64'));
  return target;
}

// ── 10. 像素层：JPEG/PNG 解码 + 游离墨块扫描 ──────────────────────────────
//
// This is the layer that decides whether a dark blip in the scan is a stray
// dot. It has no business being untested: a threshold that silently stops
// reporting a real dot is invisible to every other check here, because the
// handoff text still looks perfectly well formed.
process.stdout.write('\n10. 像素层（解码 + 游离墨块扫描）\n');
{
  const { decodeGray, decodeGrayPng } = await import('../lib/jpeg.mjs');
  const { findSpecks } = await import('../lib/scan.mjs');
  const { buildScanSection, buildTranscribeRequest } = await import('../lib/prompt.mjs');
  const { encodeGrayPng } = await import('./png-fixture.mjs');

  // A solid dot: the thing we must never miss.
  const withDot = await encodeGrayPng((x, y) => (x >= 10 && x < 16 && y >= 10 && y < 16 ? 0 : 255), 64, 64);
  const dotScan = findSpecks(decodeGrayPng(withDot));
  eq('合成图：报出 1 处游离墨块', dotScan.specks.length, 1);
  eq('合成图：位置落在墨点中心', [dotScan.specks[0]?.x, dotScan.specks[0]?.y], [12, 12]);
  eq('合成图：尺寸为 6x6', [dotScan.specks[0]?.width, dotScan.specks[0]?.height], [6, 6]);
  eq('合成图：这张图只有 1 个连通域', dotScan.componentCount, 1);

  // Clean paper must produce nothing, or every figure starts with a phantom.
  const blank = await encodeGrayPng(() => 255, 64, 64);
  eq('合成图：空白页报 0 处', findSpecks(decodeGrayPng(blank)).specks.length, 0);

  // A hollow shape the size of a glyph is a drawn object, not a speck.
  const ring = await encodeGrayPng(
    (x, y) => (x >= 8 && x < 40 && y >= 8 && y < 40 && (x < 11 || x >= 37 || y < 11 || y >= 37) ? 0 : 255),
    64,
    64,
  );
  const ringScan = findSpecks(decodeGrayPng(ring));
  eq('合成图：空心方框不算游离墨块', ringScan.specks.length, 0);
  eq('合成图：空心方框被记入 hollow 以便复查', ringScan.hollow.length, 1);

  // Border remnants are cropping artefacts. Listing them as marks would invent
  // up to seven phantom points on figures/2.jpg.
  const edge = await encodeGrayPng((x, y) => (y < 3 && x < 30 ? 0 : 255), 64, 64);
  const edgeScan = findSpecks(decodeGrayPng(edge));
  eq('合成图：贴边墨条不算游离墨块', edgeScan.specks.length, 0);
  ok('合成图：贴边墨条单独列为边缘截断', edgeScan.clipped.length >= 1, `clipped=${edgeScan.clipped.length}`);

  // The real scans. Their stray dots are the entire reason this plugin exists,
  // and they differ by two orders of magnitude in area, so a threshold tuned on
  // one of them alone is exactly the mistake to guard against.
  const figs = figurePaths();
  if (figs) {
    const s1 = findSpecks(decodeGray(readFileSync(figs.fig1)));
    eq('figures/1.jpg：恰好 1 处游离墨块', s1.specks.length, 1);
    eq('figures/1.jpg：位置 (1124,225)', [s1.specks[0]?.x, s1.specks[0]?.y], [1124, 225]);
    eq('figures/1.jpg：尺寸 3x3、面积 6', [s1.specks[0]?.width, s1.specks[0]?.height, s1.specks[0]?.area], [3, 3, 6]);
    ok('figures/1.jpg：没有把字形误报为墨块', s1.specks.every((b) => b.area <= 1200), JSON.stringify(s1.specks.map((b) => b.area)));

    const s2 = findSpecks(decodeGray(readFileSync(figs.fig2)));
    eq('figures/2.jpg：恰好 1 处游离墨块', s2.specks.length, 1);
    eq('figures/2.jpg：位置 (2372,322)', [s2.specks[0]?.x, s2.specks[0]?.y], [2372, 322]);
    eq('figures/2.jpg：尺寸 31x47、面积 1139', [s2.specks[0]?.width, s2.specks[0]?.height, s2.specks[0]?.area], [31, 47, 1139]);
    // The regression this guards: a limit tuned to 1.jpg (area <= 600) dropped
    // the 2.jpg dot, and a limit tuned to 2.jpg (area <= 2000) would start
    // reporting its letters.
    ok('figures/2.jpg：面积上限足以覆盖 1139', s2.thresholds.maxArea >= 1139, `maxArea=${s2.thresholds.maxArea}`);
    eq('figures/2.jpg：贴边残留共 7 处', s2.clipped.length, 7);

    // 7.jpg is the counter-example that justifies run detection: its dashes are
    // small and solid, and offering them as dots invents nine objects. It is
    // optional here only because it is one more borrowed scan, not because the
    // assertion matters less.
    const fig7 = join(figs.dir, '7.jpg');
    if (existsSync(fig7)) {
      const s7 = findSpecks(decodeGray(readFileSync(fig7)));
      ok('figures/7.jpg：虚线被判为线段而不是游离墨块', s7.dashRuns.length >= 1, `runs=${s7.dashRuns.length}`);
      ok('figures/7.jpg：成排虚线已从游离墨块中剔除', s7.specks.length <= 5, `specks=${s7.specks.length}（未识别虚线时为 9）`);
    } else {
      process.stdout.write('  · 跳过 figures/7.jpg（虚线剔除断言）\n');
    }

    // The scan must actually reach the model. Measuring blobs and then not
    // sending the numbers would leave the whole layer inert.
    const section = buildScanSection(s1, 0, 1);
    ok('扫描结果进入提示词：含精确像素坐标', section.includes('(1124, 225)'), section.split('\n').find((l) => l.startsWith('1.')) ?? '');
    ok('扫描结果进入提示词：含精确尺寸', section.includes('3×3 像素'));
    ok('扫描结果进入提示词：禁止据此新增质点', section.includes('都不许因为这里列出的任何一块墨而新增质点'));
    ok('扫描结果进入提示词：允许模型推翻程序结论', section.includes('不能判断它是不是题目的一部分'));
    const req = buildTranscribeRequest({
      label: '第 1 题',
      images: [figs.fig1],
      imageInfo: [{ width: 1536, height: 2711, bytes: 187773 }],
      scans: [s1],
    });
    ok('请求文本里带着扫描结果', req.includes('(1124, 225)') && req.includes('机械像素扫描结果'));

    // A figure with no stray marks must still be described from looking at it:
    // "the program found nothing" is not permission to see nothing.
    const cleanScan = { specks: [], clipped: [], hollow: [], dashRuns: [], thresholds: s1.thresholds, width: 100, height: 100 };
    const cleanReq = buildTranscribeRequest({
      label: '第 3 题',
      images: [figs.fig1],
      imageInfo: [{ width: 3045, height: 1536, bytes: 1 }],
      scans: [cleanScan],
    });
    ok('无墨块时请求明说没有发现', cleanReq.includes('没有发现任何 3 像素以上的游离墨块'));
    ok('无墨块时仍要求据实描述所见', cleanReq.includes('不要因为「程序说没有」就否认你确实看到的东西'));
  } else {
    process.stdout.write(`  · 跳过真实扫描图（${describeFixtures()}）\n`);
  }
}

function parseYamlText(text) {
  // The Loader's YAML is a superset we do not need here; the subset below is
  // enough for this patch and keeps the check dependency-free.
  const lines = text.split(/\r?\n/);
  const root = [];
  let insert = null;
  let current = null;
  let currentConfig = null;
  for (const line of lines) {
    if (/^\s*#/.test(line) || !line.trim()) continue;
    const mInsert = line.match(/^-\s+insert:\s*$/);
    if (mInsert) {
      insert = [];
      root.push({ insert });
      continue;
    }
    const mRow = line.match(/^(\s+)-\s+id:\s*(.+?)\s*$/);
    if (mRow && insert) {
      current = { id: unquote(mRow[2]), config: {} };
      insert.push(current);
      currentConfig = null;
      continue;
    }
    const mName = line.match(/^\s+name:\s*(.+?)\s*$/);
    if (mName && current) {
      current.name = unquote(mName[1]);
      continue;
    }
    const mCfg = line.match(/^\s+config:\s*$/);
    if (mCfg && current) {
      currentConfig = current.config;
      continue;
    }
    const mKV = line.match(/^\s+([A-Za-z_][\w]*):\s*(.*?)\s*$/);
    if (mKV && currentConfig) {
      const [, k, v] = mKV;
      if (v === '') continue; // a commented-out or nested key: not part of the shape check
      currentConfig[k] = unquote(v);
    }
  }
  return root;
}

function unquote(s) {
  const t = s.trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) return t.slice(1, -1);
  return t;
}

// ── 11. marketplace manifest ───────────────────────────────────────────────
//
// A package can be a perfectly good DSH bundle and still be refused by the
// market: `dsh.bundle` describes how the Loader activates it, which is a
// different question from whether the manifest declares itself legally. The
// published schema is the authority; the rules below are transcribed from
// `dsh-plugin-0.15.schema.json` (pinned copy beside this file, provenance in
// its `$comment`), so this section stays offline and still fails for the
// reasons the schema would. `tools/validate-manifest.mjs` then runs the real
// schema document, so this transcription is never the last word.
process.stdout.write('\n11. 插件市场清单（dsh-plugin.json, manifest v0.15）\n');

const manifestPath = join(ROOT, 'dsh-plugin.json');
if (!existsSync(manifestPath)) {
  ok('存在 dsh-plugin.json', false, '缺少市场清单：market 会看不到这个包');
} else {
  const raw = readFileSync(manifestPath, 'utf8');
  let m = null;
  try {
    m = JSON.parse(raw);
    ok('dsh-plugin.json 是合法 JSON', true);
  } catch (err) {
    ok('dsh-plugin.json 是合法 JSON', false, err.message);
  }

  if (m) {
    const SCHEMA_URL =
      'https://raw.githubusercontent.com/T-Auto/dsh-std/8a15541117cb3c13ddb8f2468308691b6051d162/packages/manifest/schema/dsh-plugin-0.15.schema.json';
    for (const key of ['$schema', 'manifestVersion', 'id', 'name', 'version', 'facets']) {
      ok(`含必填字段 ${key}`, key in m, key in m ? '' : `缺少 ${key}`);
    }
    eq('$schema 指向 0.15 版本化 URL', m.$schema, SCHEMA_URL);
    eq('manifestVersion 是 0.15', m.manifestVersion, '0.15');

    // namespacedId: ^[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*)+$
    // A bare `read-figure` does NOT match: the pattern requires at least one
    // separator, so a plain package name is not a legal manifest id.
    const NS = /^[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*)+$/;
    ok('id 合法（namespacedId）', typeof m.id === 'string' && NS.test(m.id), `id=${JSON.stringify(m.id)}。须形如 a.b 或 a-b.c，纯包名不合规`);
    ok('id 与包名不同但同源', m.id !== pkg.name && String(m.id).startsWith(pkg.name.slice(0, 5)), `id=${m.id} 包名=${pkg.name}`);
    eq('manifest 的 name 与包名一致', m.name, pkg.name);
    eq('manifest 的 version 与包版本一致', m.version, pkg.version);
    eq('manifest 的 license 与包 license 一致', m.license, pkg.license);

    // facets.host.entry must be a real, relative, non-escaping path.
    const entry = m.facets?.host?.entry;
    ok('facets.host.entry 存在', typeof entry === 'string' && entry.length > 0, String(entry));
    ok('facets.host.entry 不是绝对路径也不是向上逃逸', !/^([\\/]|[A-Za-z]:[\\/])/.test(entry ?? '') && !/(^|[\\/])\.\.([\\/]|$)/.test(entry ?? ''), String(entry));
    ok('facets.host.entry 指向实际存在的文件', existsSync(join(ROOT, entry ?? '__missing__')), String(entry));
    ok('facets.host.apiVersion 形如 v1alpha1', /^v[1-9][0-9]*(?:(?:alpha|beta)[1-9][0-9]*)?$/.test(m.facets?.host?.apiVersion ?? ''), String(m.facets?.host?.apiVersion));
    // The entry the manifest advertises must be the entry the Loader loads, or
    // the market's idea of this plugin and the runtime's would differ. The
    // manifest's own convention is the bare form (`lib/index.js`, as the
    // reference dsh-ops manifest has it), so compare on the normalised path
    // rather than on the presence of a leading `./`.
    {
      const norm = (p) => String(p ?? '').replace(/^\.\//, '');
      ok(
        'facets.host.entry 与 package.json exports["."] 指向同一文件',
        norm(m.facets?.host?.entry) === norm(entry),
        `exports=${entry} entry=${m.facets?.host?.entry}`,
      );
    }

    // contracts: the tool this plugin registers is a Tool contract.
    const contracts = m.requires?.contracts;
    ok('requires.contracts 是非空数组', Array.isArray(contracts) && contracts.length > 0);
    ok('声明了 tools.dsh/v1alpha1 Tool 契约', (contracts ?? []).some((c) => c.apiVersion === 'tools.dsh/v1alpha1' && c.kind === 'Tool'), JSON.stringify(contracts));
    ok('每个契约都带 apiVersion 与 kind', (contracts ?? []).every((c) => typeof c.apiVersion === 'string' && /^[A-Z][A-Za-z0-9]*$/.test(c.kind ?? '')), JSON.stringify(contracts));

    // permissions: name must be namespaced, scope non-empty, reason mandatory.
    const perms = m.permissions;
    ok('permissions 是数组', Array.isArray(perms));
    ok('每条 permission 的 name 都是 namespacedId', (perms ?? []).every((p) => NS.test(p.name ?? '')), JSON.stringify((perms ?? []).map((p) => p.name)));
    ok('每条 permission 都写了 scope 与 reason', (perms ?? []).every((p) => typeof p.scope === 'string' && p.scope.length > 0 && typeof p.reason === 'string' && p.reason.length > 0), JSON.stringify((perms ?? []).map((p) => p.name)));
    // The plugin makes exactly one kind of outbound call, so it must say so.
    ok('声明了出网权限（本插件会调用视觉端点）', (perms ?? []).some((p) => p.scope === 'network'), JSON.stringify((perms ?? []).map((p) => p.scope)));

    // contributes: only x- extensions and the two reserved arrays are legal.
    const contributes = m.contributes ?? {};
    const illegal = Object.keys(contributes).filter((k) => k !== 'commands' && k !== 'panels' && !k.startsWith('x-'));
    ok('contributes 里没有非 x- 的自定义键', illegal.length === 0, illegal.join(','));
    ok('contributes.panels 为空（无客户端界面）', !contributes.panels || contributes.panels.length === 0);
    ok('每个 x- 扩展键的值都是数组', Object.entries(contributes).filter(([k]) => k.startsWith('x-')).every(([, v]) => Array.isArray(v)), Object.keys(contributes).filter((k) => k.startsWith('x-')).join(','));

    const display = contributes['x-display']?.[0];
    ok('x-display 提供了 title/description', typeof display?.title === 'string' && typeof display?.description === 'string');
    ok('x-display 的 icon 指向存在的文件', !!display?.icon && existsSync(join(ROOT, display.icon.replace(/^\.\//, ''))), String(display?.icon));
    ok('x-display 声明的每个 locale 文件都存在', (display?.locales ?? []).length > 0 && display.locales.every((f) => existsSync(join(ROOT, f))), JSON.stringify(display?.locales));
    for (const f of display?.locales ?? []) {
      let loc = null;
      try {
        loc = JSON.parse(readFileSync(join(ROOT, f), 'utf8'));
      } catch (err) {
        ok(`${f} 是合法 JSON`, false, err.message);
      }
      if (loc) ok(`${f} 含 title 与 description`, typeof loc.title === 'string' && typeof loc.description === 'string');
    }

    // The namespace row must name the tool the code actually registers.
    const ns = contributes['x-tool-namespaces']?.[0];
    ok('x-tool-namespaces 列出了工具', Array.isArray(ns?.tools) && ns.tools.length > 0, JSON.stringify(ns?.tools));
    {
      const registered = plugin.defineReadFigure({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', maxTokens: 1, reasoningEffort: 'low', timeoutMs: 1000 }).name;
      eq('x-tool-namespaces 的工具名与代码注册的一致', ns?.tools?.[0], registered);
    }
    ok('x-tool-namespaces 的 serverName 与包名一致', ns?.serverName === pkg.name, String(ns?.serverName));

    ok('subscriptions 是数组', Array.isArray(m.subscriptions));
    // artifact/source are publication-time fields; if present they must be well formed.
    if (m.source) ok('source.repository 是 URI', typeof m.source.repository === 'string' && /^[a-z][a-z0-9+.-]*:|^git\+/.test(m.source.repository), String(m.source.repository));
    if (m.artifact) ok('artifact.digest 形如 sha256:<64 hex>', /^sha256:[a-f0-9]{64}$/.test(m.artifact.digest ?? '') && m.artifact.algorithm === 'sha256', JSON.stringify(m.artifact));

    // `files` must ship the manifest, or the published tarball loses it.
    ok('package.json 的 files 包含 dsh-plugin.json', (pkg.files ?? []).includes('dsh-plugin.json'), JSON.stringify(pkg.files));
    ok('package.json 的 files 包含 locale/', (pkg.files ?? []).some((f) => f.replace(/\/$/, '') === 'locale'));
  }
}

// Section 12 exists because the mount path is the one thing a live dsh refused
// once and no offline test could see: a plain object in `Config` produced
// `TypeError: Cannot read properties of undefined (reading 'validate')` inside
// the Loader, after `pnpm add` had already reported success. Everything below
// drives `apply` through a stand-in context so a regression fails here instead
// of in a restarted profile. It is a stand-in, not the Loader: it cannot prove
// the row is reachable, only that the export is shaped like a plugin and
// behaves when mounted.
process.stdout.write('\n12. 挂载路径（用替身 ctx 真调一次 apply）\n');
{
  const mkCtx = () => {
    const registered = [];
    const effects = [];
    const logs = [];
    return {
      registered, effects, logs,
      ctx: {
        tools: { register: (def) => { registered.push(def); return () => registered.pop(); } },
        // Cordis runs an effect body, then owns its disposer. Running it here
        // is what makes the registration observable at all.
        effect: (fn) => { effects.push(fn); const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; },
        logger: {
          info: (m) => logs.push(['info', m]),
          warn: (m) => logs.push(['warn', m]),
        },
      },
    };
  };

  ok('inject 恰好是 [tools]', Array.isArray(plugin.inject) && plugin.inject.length === 1 && plugin.inject[0] === 'tools', JSON.stringify(plugin.inject));
  ok('apply 是函数', typeof plugin.apply === 'function');

  // (a) healthy mount: one tool, registered through a context effect.
  {
    const { ctx, registered, effects } = mkCtx();
    plugin.apply(ctx, { apiKey: 'sk-offline-test' });
    ok('apply 走 ctx.effect 注册（而不是直接注册）', effects.length === 1, `effects=${effects.length}`);
    ok('effect 回调里注册了恰好一个工具', registered.length === 1, `registered=${registered.length}`);
    const def = registered[0];
    ok('挂载出的工具名是 read_figure', def?.name === 'read_figure', String(def?.name));
    // The same check the API applies, run against the definition that actually
    // reached `ctx.tools.register` — the mount path is where the map-shaped
    // schema shipped, so this is the assertion that would have caught it.
    checkToolParameters(def?.parameters, '挂载时注册的 parameters');
    ok('挂载出的工具有 output.render', typeof def?.output?.render === 'function');
    ok('output.render 返回文本块', (() => {
      try { const b = def.output.render({}, 'x'); return Array.isArray(b) && b[0]?.type === 'text' && b[0].text === 'x'; } catch { return false; }
    })());
    ok('挂载出的工具有 execute', typeof def?.execute === 'function');
    ok('timeoutMs 是正有限数（否则 defineTool/register 会拒）', Number.isFinite(def?.timeoutMs) && def.timeoutMs > 0, String(def?.timeoutMs));
  }

  // (b) no credentials: refuse to register, warn, and do not throw. The plugin
  // must not take the whole profile down over a missing key, but it also must
  // not register a tool that can only fail once the model has committed to it.
  // `apply` reads the ambient environment and the credential files, so the only
  // honest way to reach this branch offline is to run it in a child process
  // with both pointed at a scratch directory. (One child, two assertions — the
  // alternative was adding a test-only config key.)
  {
    const scratch = mkdtempSync(join(tmpdir(), 'read-figure-nokey-'));
    try {
      const probe = join(scratch, 'probe.mjs');
      writeFileSync(probe, `
import { pathToFileURL } from 'node:url';
const mod = await import(pathToFileURL(${JSON.stringify(join(ROOT, 'lib', 'index.mjs'))}).href);
const registered = [];
const logs = [];
mod.apply({
  tools: { register: (d) => { registered.push(d); return () => {}; } },
  effect: (fn) => { fn(); return () => {}; },
  logger: { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]) },
}, {});
process.stdout.write(JSON.stringify({ registered: registered.length, warn: logs.some(([l]) => l === 'warn') }));
`, 'utf8');

      const env = { ...process.env };
      for (const k of ['READ_FIGURE_API_KEY', 'DEEPSEEK_API_KEY']) delete env[k];
      // Point every credential lookup root at the empty scratch directory.
      for (const k of ['DSH_HOME', 'HOME', 'USERPROFILE']) env[k] = scratch;
      const r = spawnSync(process.execPath, [probe], { env, encoding: 'utf8' });
      let parsed = null;
      try { parsed = JSON.parse(r.stdout ?? ''); } catch { /* reported below */ }
      ok('没有密钥时不注册工具', parsed?.registered === 0, `stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify((r.stderr ?? '').slice(0, 200))}`);
      ok('没有密钥时发出 warn', parsed?.warn === true, `stdout=${JSON.stringify(r.stdout)}`);
      ok('没有密钥时不抛异常（否则会炸掉整个 profile）', r.status === 0, `status=${r.status} stderr=${JSON.stringify((r.stderr ?? '').slice(0, 200))}`);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  // (c) a ctx with no logger must not be fatal: optional services stay optional.
  {
    const { ctx, registered } = mkCtx();
    delete ctx.logger;
    try {
      plugin.apply(ctx, { apiKey: 'sk-offline-test' });
      ok('ctx 没有 logger 也能挂载', registered.length === 1, `registered=${registered.length}`);
    } catch (err) {
      ok('ctx 没有 logger 也能挂载', false, err.message);
    }
  }
}

// ── 13. type declaration matches the runtime exports ───────────────────────
//
// `lib/index.d.ts` is hand-written, and it had drifted in BOTH directions: it
// declared `defaults`, `DEFAULTS`, `probeImage`, `decodeGray`, `decodeGrayPng`
// and `findSpecks` that `lib/index.mjs` never re-exported, while silently
// omitting twelve names that it did export (`describeFigures`, `composeHandoff`,
// `finalizeHandoff`, `writeHandoff`, `resolveHandoffPath`, `credentialCandidates`,
// `credentialsPath`, `apply`, `defineReadFigure`, `name`, `inject`, `VisionError`).
//
// A stale declaration is worse than no declaration: TypeScript accepts the
// import, the editor autocompletes it, and the value is `undefined` at run time
// with nothing failing in between. So the names are compared here against the
// live module both ways. Checked by name, not by type — a text parser cannot
// judge a type, but it can catch a rename, a deletion, and a promise that was
// never kept, which is what actually went wrong.
process.stdout.write('13. 类型声明与运行时导出一致\n');
{
  const dtsPath = join(ROOT, 'lib/index.d.ts');
  ok('lib/index.d.ts 存在', existsSync(dtsPath));
  if (existsSync(dtsPath)) {
    const dts = readFileSync(dtsPath, 'utf8');

    // Two separate name sets. `interface` and `type` are type-only: they are
    // erased at run time, so declaring them is not a promise that anything will
    // exist. `const`/`function`/`class`/`enum` DO promise a runtime value, and
    // that is the direction where drift produces a silent `undefined`.
    const declaredTypes = new Set();
    const declaredValues = new Set();
    for (const m of dts.matchAll(/^\s*export\s+(?:declare\s+)?(const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm)) {
      (m[1] === 'interface' || m[1] === 'type' ? declaredTypes : declaredValues).add(m[2]);
    }
    // `export { a, b as c };` — only the exported name is collected. A bare
    // `export { Foo }` re-exports whatever `Foo` already is, so it is counted as
    // a value only when it is not one of the type-only names; `export type { T }`
    // is always a type.
    for (const m of dts.matchAll(/^\s*export\s+(type\s+)?\{([^}]*)\}/gm)) {
      const typeOnly = Boolean(m[1]);
      for (const part of m[2].split(',')) {
        const piece = part.trim().replace(/^type\s+/, '');
        if (!piece) continue;
        const as = piece.split(/\s+as\s+/);
        const exported = (as[1] ?? as[0]).trim();
        if (!exported) continue;
        (typeOnly || declaredTypes.has(exported) ? declaredTypes : declaredValues).add(exported);
      }
    }
    ok('能从 .d.ts 里解析出导出名', declaredValues.size >= 10, `${declaredValues.size} 个值 + ${declaredTypes.size} 个纯类型`);
    ok('声明了 default 导出', /^\s*export\s+default\s/m.test(dts));

    // `default` is an export of the module but never a named one, so it is not
    // in this list; `plugin` is the namespace object, so its own keys are it.
    const runtime = Object.keys(plugin).filter((k) => k !== 'default');
    const missing = runtime.filter((k) => !declaredValues.has(k));
    const phantom = [...declaredValues].filter((k) => !runtime.includes(k));

    ok('.d.ts 没有漏掉任何运行时导出', missing.length === 0, missing.length ? `缺少 ${missing.join(', ')}` : `${runtime.length} 个全部声明`);
    ok('.d.ts 没有声明运行时不存在的导出', phantom.length === 0, phantom.length ? `凭空声明 ${phantom.join(', ')}` : '无凭空声明');

    // The two checks above compare names only; this one requires the name to
    // resolve to a real value. `=== undefined` rather than truthiness: `DEFAULTS`
    // is an object and `name` is a non-empty string, but a future export that is
    // legitimately `0`, `''` or `false` must not fail here.
    const valueless = runtime.filter((k) => plugin[k] === undefined);
    ok('每个运行时导出都解析出真实值', valueless.length === 0, valueless.length ? `值为 undefined：${valueless.join(', ')}` : `${runtime.length} 个都有值`);

    // A type declared but never referenced is dead weight in a published file —
    // usually the leftover half of a rename. Allow the ones that are referenced
    // by another declaration; flag the ones that are not.
    const orphans = [...declaredTypes].filter((t) => {
      const uses = dts.match(new RegExp(`\\b${t}\\b`, 'g')) ?? [];
      return uses.length <= 1;
    });
    ok('.d.ts 里没有无人引用的纯类型', orphans.length === 0, orphans.length ? `只出现一次：${orphans.join(', ')}` : `${declaredTypes.size} 个类型都被引用`);

    // The declarations are what a consumer reads; the docs promise `DEFAULTS` is
    // the single source of defaults, so both the runtime and the declaration
    // must carry it or the README is describing a different package.
    ok('DEFAULTS 既在运行时导出也在 .d.ts 声明', plugin.DEFAULTS !== undefined && declaredValues.has('DEFAULTS'));
  }

  const typesField = typeof pkg.types === 'string' ? pkg.types : pkg.exports?.['.']?.types;
  ok('package.json 声明了 types 入口', typeof typesField === 'string', String(typesField));
  ok('types 入口指向存在的文件', typeof typesField === 'string' && existsSync(join(ROOT, typesField)), String(typesField));
}

// ── 14. documented defaults agree with DEFAULTS ────────────────────────────
{
  process.stdout.write('\n文档里的缺省值\n');

  // The READMEs promise that `DEFAULTS` is the single source of defaults, and
  // both tables went on listing `maxTokens` as 8000 long after the code moved to
  // 32000 — so a reader who trusted the table set the one value that empties a
  // handoff. A table nobody checks is just a second copy of the truth, and the
  // second copy is the one that drifts. Rows are fixed-width and machine
  // readable on purpose: `| `key` | `value` | …`.
  const EXPECT = {
    baseUrl: plugin.DEFAULTS.baseUrl,
    model: plugin.DEFAULTS.model,
    apiKey: "''",
    maxTokens: String(plugin.DEFAULTS.maxTokens),
    reasoningEffort: plugin.DEFAULTS.reasoningEffort,
    timeoutMs: String(plugin.DEFAULTS.timeoutMs),
    promptFile: "''",
    extraInstruction: "''",
    handoffDir: "''",
    writeHandoff: 'false',
  };

  for (const md of ['README.md', 'README.zh.md']) {
    const text = readFileSync(join(ROOT, md), 'utf8');
    const wrong = [];
    for (const [key, want] of Object.entries(EXPECT)) {
      const m = text.match(new RegExp('^\\| `' + key + '` \\| `([^`]*)` \\|', 'm'));
      if (!m) wrong.push(`${key} 缺行`);
      else if (m[1] !== want) wrong.push(`${key}=${m[1]}≠${want}`);
    }
    ok(`${md} 的缺省值表与 DEFAULTS 一致`, wrong.length === 0, wrong.length ? wrong.join('; ') : `${Object.keys(EXPECT).length} 个键全部一致`);
  }

  // `--help` is the surface a user meets before the README, and it had its own
  // retyped `缺省 8000`. Same treatment: every documented default must come from
  // DEFAULTS, so the numbers cannot disagree with the code that uses them.
  const help = spawnSync(process.execPath, [join(ROOT, 'bin', 'read-figure.mjs'), '--help'], { encoding: 'utf8' });
  const out = `${help.stdout ?? ''}${help.stderr ?? ''}`;
  const wanted = [plugin.DEFAULTS.maxTokens, plugin.DEFAULTS.model, plugin.DEFAULTS.baseUrl, plugin.DEFAULTS.timeoutMs, plugin.DEFAULTS.reasoningEffort];
  const absent = wanted.filter((v) => !out.includes(String(v)));
  ok('CLI 的 --help 里缺省值取自 DEFAULTS', absent.length === 0, absent.length ? `缺 ${absent.join(', ')}` : `${wanted.length} 个缺省值都在`);
  ok('CLI --help 没有把某个缺省值写死成旧值', !/缺省 8000/.test(out));
}

process.stdout.write(`
结果：${pass} 项通过，${fail} 项失败
`);
process.exit(fail ? 1 : 0);
