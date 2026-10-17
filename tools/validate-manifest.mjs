// Validate dsh-plugin.json against the published manifest schema.
//
// check.mjs transcribes the schema's rules so its main run stays offline, but a
// transcription is an opinion. This runs the real schema document through a
// real (small) JSON Schema validator, so "it validates" is a fact rather than a
// reading of the rules.
//
// The schema is fetched live and cached beside this file; `--offline` uses the
// cache only. JSON Schema features used by the 0.15 document: type, const, enum,
// pattern, minLength, maxLength, minimum, maximum, required, properties,
// additionalProperties (bool), patternProperties, items, maxItems, minItems,
// oneOf, $ref (local and URL), $defs. `format: uri` is validated leniently —
// this package's schema only uses it on source.repository.
//
//   node tools/validate-manifest.mjs [--offline]

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolvePath(HERE, '..');
const CACHE = join(HERE, 'schema', 'dsh-plugin-0.15.schema.json');
const OFFLINE = process.argv.includes('--offline');

const manifest = JSON.parse(readFileSync(join(ROOT, 'dsh-plugin.json'), 'utf8'));
const schemaUrl = manifest.$schema;

async function loadSchema() {
  if (existsSync(CACHE)) return JSON.parse(readFileSync(CACHE, 'utf8'));
  if (OFFLINE) throw new Error(`离线模式但缓存不存在：${CACHE}`);
  process.stdout.write(`下载 schema：${schemaUrl}\n`);
  const res = await fetch(schemaUrl);
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const text = await res.text();
  mkdirSync(dirname(CACHE), { recursive: true });
  writeFileSync(CACHE, text);
  return JSON.parse(text);
}

/** Resolve a $ref against the root document and any already-fetched documents. */
async function resolveRef(ref, root, base) {
  if (ref.startsWith('#/')) {
    let node = root;
    for (const part of ref.slice(2).split('/')) {
      node = node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    }
    if (node === undefined) throw new Error(`无法解析 $ref ${ref}`);
    return node;
  }
  const abs = new URL(ref, base ?? schemaUrl).href;
  if (!docs.has(abs)) {
    if (OFFLINE) throw new Error(`离线模式无法解析外部 $ref ${abs}`);
    const res = await fetch(abs);
    if (!res.ok) throw new Error(`下载 $ref 失败 HTTP ${res.status}: ${abs}`);
    docs.set(abs, await res.json());
  }
  return docs.get(abs);
}

const docs = new Map();

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function typeMatches(value, want) {
  const t = typeOf(value);
  if (want === 'number') return t === 'number' || t === 'integer';
  if (want === 'integer') return t === 'integer';
  return t === want;
}

async function validate(value, schema, path, errors, root, base) {
  if (schema === true || schema === undefined) return;
  if (schema === false) {
    errors.push(`${path}: schema 为 false，不允许任何值`);
    return;
  }
  if (schema.$ref) {
    const target = await resolveRef(schema.$ref, root, base);
    const nextBase = schema.$ref.startsWith('#/') ? base : new URL(schema.$ref, base ?? schemaUrl).href;
    return validate(value, target, path, errors, root, nextBase);
  }

  if (schema.type) {
    const wants = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!wants.some((w) => typeMatches(value, w))) {
      errors.push(`${path}: 类型应为 ${wants.join('|')}，实为 ${typeOf(value)}`);
      return;
    }
  }
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: 应为常量 ${JSON.stringify(schema.const)}，实为 ${JSON.stringify(value)}`);
  }
  if (schema.enum && !schema.enum.some((e) => e === value)) {
    errors.push(`${path}: 不在枚举 ${JSON.stringify(schema.enum)} 内（实为 ${JSON.stringify(value)}）`);
  }
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: 不匹配 pattern ${schema.pattern}（实为 ${JSON.stringify(value)}）`);
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: 长度 ${value.length} < minLength ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path}: 长度 ${value.length} > maxLength ${schema.maxLength}`);
    }
    if (schema.format === 'uri' && !/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^git\+/.test(value)) {
      errors.push(`${path}: 不像 URI（${JSON.stringify(value)}）`);
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: ${value} > maximum ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: 只有 ${value.length} 项，需 ≥ ${schema.minItems}`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: 有 ${value.length} 项，需 ≤ ${schema.maxItems}`);
    if (schema.items) {
      for (let i = 0; i < value.length; i++) await validate(value[i], schema.items, `${path}[${i}]`, errors, root, base);
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const req of schema.required ?? []) {
      if (!(req in value)) errors.push(`${path}: 缺少必填字段 ${req}`);
    }
    for (const [k, v] of Object.entries(value)) {
      let matched = false;
      if (schema.properties && k in schema.properties) {
        matched = true;
        await validate(v, schema.properties[k], `${path}.${k}`, errors, root, base);
      }
      for (const [pat, sub] of Object.entries(schema.patternProperties ?? {})) {
        if (new RegExp(pat).test(k)) {
          matched = true;
          await validate(v, sub, `${path}.${k}`, errors, root, base);
        }
      }
      if (!matched && schema.additionalProperties === false) {
        const allowed = [...Object.keys(schema.properties ?? {}), ...Object.keys(schema.patternProperties ?? {})];
        errors.push(`${path}.${k}: 不允许的额外字段（允许：${allowed.join(', ') || '无'}）`);
      } else if (!matched && schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        await validate(v, schema.additionalProperties, `${path}.${k}`, errors, root, base);
      }
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const results = [];
    for (const sub of schema.oneOf) {
      const errs = [];
      await validate(value, sub, path, errs, root, base);
      results.push(errs);
    }
    const passing = results.filter((e) => e.length === 0).length;
    if (passing !== 1) {
      errors.push(`${path}: oneOf 需恰好命中 1 个分支，实为 ${passing} 个`);
    }
  }
}

const schema = await loadSchema();
const errors = [];
await validate(manifest, schema, 'dsh-plugin.json', errors, schema, undefined);

const rel = (p) => p.replace(ROOT, '.').replace(/\\/g, '/');
if (errors.length === 0) {
  process.stdout.write(`✔ 清单合法：${rel(join(ROOT, 'dsh-plugin.json'))} 通过 manifest v0.15 schema（共 ${Object.keys(manifest).length} 个顶层字段）\n`);
  process.exit(0);
}
process.stdout.write(`✘ 发现 ${errors.length} 处不合规：\n`);
for (const e of errors) process.stdout.write(`  - ${e}\n`);
process.exit(1);
