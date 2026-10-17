// Syntax-check every JavaScript file the package actually ships.
//
// The script list used to be written out by hand in package.json, which meant a
// new lib/ module could be added and never checked -- exactly the file most
// likely to be broken. This derives the list from the manifest's `files` field
// instead, so lint coverage can only ever lag behind a deliberate decision to
// stop shipping a file.
//
//   node tools/lint.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolvePath(HERE, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** Every .js/.mjs file under a path, recursively. */
function jsFiles(path) {
  let st;
  try {
    st = statSync(path);
  } catch {
    return [];
  }
  if (st.isFile()) return /\.m?js$/.test(path) ? [path] : [];
  const out = [];
  for (const name of readdirSync(path)) out.push(...jsFiles(join(path, name)));
  return out;
}

const targets = [];
for (const entry of pkg.files ?? []) {
  targets.push(...jsFiles(join(ROOT, entry.replace(/\/$/, ''))));
}
// The bin is not always listed in `files`, but it is always shipped.
// tools/ is repository-only (not in `files`), which is exactly why it must be
// listed explicitly: a broken check script is the one file that cannot report
// its own breakage.
for (const extra of ['tools']) targets.push(...jsFiles(join(ROOT, extra)));
for (const rel of Object.values(pkg.bin ?? {})) targets.push(join(ROOT, rel));

const unique = [...new Set(targets)].sort();
if (!unique.length) {
  process.stdout.write('lint: 没有找到需要检查的文件\n');
  process.exit(0);
}

let bad = 0;
for (const f of unique) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (err) {
    bad++;
    process.stdout.write(`✘ ${f.replace(ROOT, '.')}\n${err.stderr?.toString() ?? err.message}\n`);
  }
}
process.stdout.write(`lint: 检查 ${unique.length} 个文件，${bad} 个失败\n`);
process.exit(bad ? 1 : 0);
