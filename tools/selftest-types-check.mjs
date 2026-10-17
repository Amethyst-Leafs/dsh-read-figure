// Self-test for the section-13 assertions in tools/check.mjs.
//
// The assertions in section 13 compare `lib/index.d.ts` against the live exports
// of `lib/index.mjs`. That comparison is only worth having if it actually fails
// when the two disagree, so this script extracts section 13 from check.mjs and
// runs it against a temporary tree where the declaration has been mutated.
//
// It deliberately does NOT mutate the real files. A tool that rewrites tracked
// sources and restores them loses the sources if it is interrupted between the
// two writes — a self-test that can corrupt the repository it is testing is not
// a self-test. Instead the mutation lands in a scratch directory, section 13 is
// evaluated against that directory, and the real tree is never opened for write.
//
//   node tools/selftest-types-check.mjs
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, readdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve as resolvePath } from 'node:path';

/** Recursively copy a directory. Used to give the scratch tree a loadable module graph. */
function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const e of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, e.name);
    const dst = join(to, e.name);
    if (e.isDirectory()) copyTree(src, dst);
    else if (e.isFile()) copyFileSync(src, dst);
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolvePath(HERE, '..');

const checkSource = readFileSync(join(ROOT, 'tools/check.mjs'), 'utf8');
const start = checkSource.indexOf('// ── 13.');
const end = checkSource.indexOf('process.stdout.write(`\n结果：');
if (start < 0 || end < 0 || end < start) {
  process.stdout.write('✘ 无法从 tools/check.mjs 里定位第 13 节（头部或结尾的锚点变了）\n');
  process.exit(1);
}
const section13 = checkSource.slice(start, end);
process.stdout.write(`从 tools/check.mjs 里提取到第 13 节：${section13.split('\n').length} 行\n`);

const declarationPath = join(ROOT, 'lib/index.d.ts');
const declaration = readFileSync(declarationPath, 'utf8');
const indexSource = readFileSync(join(ROOT, 'lib/index.mjs'), 'utf8');

// Each case: (a) what to change in the .d.ts or the runtime export list,
// (b) the fragment the assertion is expected to print, so a case cannot pass by
// failing for the wrong reason.
const CASES = [
  {
    name: '在 .d.ts 里凭空声明一个导出（这正是仓库里发生过的漂移）',
    dts: (s) => `${s}\nexport function totalNonsense(): void;\n`,
    expect: '凭空声明 totalNonsense',
  },
  {
    name: '把 .d.ts 里一个真实导出改名',
    dts: (s) => s.replace('export function composeHandoff(', 'export function composeHandoffRenamed('),
    expect: '缺少 composeHandoff',
  },
  {
    name: '把 .d.ts 里一个真实导出的声明整行删掉',
    dts: (s) => s.replace(/^export function writeHandoff\([\s\S]*?^\): \{ path: string; bytes: number \};\n/m, ''),
    expect: '缺少 writeHandoff',
  },
  {
    name: '从运行时删掉一个导出（.d.ts 仍然声明它）',
    index: (s) => s.replace('  describeFigures,\n', ''),
    expect: '凭空声明 describeFigures',
  },
  {
    name: '把 .d.ts 里的 DEFAULTS 改名（README 承诺它存在）',
    dts: (s) => s.replace('export const DEFAULTS: ReadFigureConfig;', 'export const DEFAULTS_RENAMED: ReadFigureConfig;'),
    expect: '凭空声明 DEFAULTS',
  },
];

const scratch = mkdtempSync(join(tmpdir(), 'read-figure-selftest-'));
let allProven = true;

try {
  // A scratch copy of the whole module graph: `lib/index.mjs` imports seven
  // sibling modules, so copying only the entry point produces a runner that dies
  // with ERR_MODULE_NOT_FOUND before a single assertion is reached — which is
  // how this script first "proved" its cases while proving nothing.
  copyTree(join(ROOT, 'lib'), join(scratch, 'lib'));
  mkdirSync(join(scratch, 'tools'), { recursive: true });
  // `pkg` is what section 13 reads out of package.json for the `types` entry.
  writeFileSync(join(scratch, 'package.json'), readFileSync(join(ROOT, 'package.json'), 'utf8'), 'utf8');

  for (const c of CASES) {
    writeFileSync(join(scratch, 'lib/index.d.ts'), (c.dts ?? ((s) => s))(declaration), 'utf8');
    writeFileSync(join(scratch, 'lib/index.mjs'), (c.index ?? ((s) => s))(indexSource), 'utf8');

    const runner = `
      import { readFileSync, existsSync } from 'node:fs';
      import { join } from 'node:path';
      import * as plugin from ${JSON.stringify(pathToFileURL(join(scratch, 'lib/index.mjs')).href)};
      const ROOT = ${JSON.stringify(scratch)};
      const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
      let pass = 0, fail = 0;
      const ok = (name, cond, detail = '') => {
        if (cond) pass++; else { fail++; process.stdout.write('✘ ' + name + (detail ? ' — ' + detail : '') + '\\n'); }
      };
${section13}
      process.stdout.write('FAILURES=' + fail + '\\n');
    `;
    const runnerPath = join(scratch, 'tools/selftest-runner.mjs');
    writeFileSync(runnerPath, runner, 'utf8');
    const r = spawnSync(process.execPath, [runnerPath], { encoding: 'utf8' });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const failures = Number(/FAILURES=(\d+)/.exec(out)?.[1] ?? '-1');
    const caught = failures > 0 && out.includes(c.expect);
    process.stdout.write(`${caught ? '✔ 被抓住' : '✘ 漏过'} — ${c.name}\n`);
    if (!caught) {
      process.stdout.write(`    期望出现「${c.expect}」，实际失败数 ${failures}\n`);
      process.stdout.write(out.split('\n').slice(0, 12).map((l) => `    ${l}`).join('\n') + '\n');
      allProven = false;
    }
  }

  // And the unmutated pair must pass, or the assertions would be vacuous.
  writeFileSync(join(scratch, 'lib/index.d.ts'), declaration, 'utf8');
  writeFileSync(join(scratch, 'lib/index.mjs'), indexSource, 'utf8');
  const r = spawnSync(process.execPath, [join(scratch, 'tools/selftest-runner.mjs')], { encoding: 'utf8' });
  const failures = Number(/FAILURES=(\d+)/.exec(r.stdout ?? '')?.[1] ?? '-1');
  process.stdout.write(`${failures === 0 ? '✔ 未被变异时全部通过' : '✘ 未被变异时也有断言失败'}\n`);
  if (failures !== 0) allProven = false;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

process.stdout.write(allProven
  ? '\n第 13 节的断言已被证明：未变异时通过，五种漂移都能被抓住。\n'
  : '\n有断言是空的，见上。\n');
process.exit(allProven ? 0 : 1);
