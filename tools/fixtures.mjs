// Locate the real scanned figures the pixel-layer assertions run against.
//
// These two files are the entire reason this plugin exists: one carries a 3x3 px
// stray speck, the other a 31x47 px stray blob, and they differ by two orders of
// magnitude. A threshold tuned on one of them alone is the mistake the tests
// exist to catch, so both must be present for the suite to mean anything.
//
// They are also ~400 KB of someone else's exam paper, so they are NOT committed
// here. Resolution order, first hit wins:
//
//   1. READ_FIGURE_FIXTURES          explicit directory override (CI, other checkouts)
//   2. <repo>/fixtures               where a contributor drops their own copies
//   3. ../output/力学_第二章_动力学基础_测试_解答/figures
//                                    the working tree this plugin was built against
//
// Returning null is a supported outcome: the suite reports the pixel-layer
// assertions as skipped rather than passing them. A skipped check is honest; a
// silently-passing one is not.

import { existsSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolvePath(HERE, '..');

const CANDIDATES = [
  process.env.READ_FIGURE_FIXTURES,
  join(REPO_ROOT, 'fixtures'),
  resolvePath(REPO_ROOT, '../output/力学_第二章_动力学基础_测试_解答/figures'),
];

/** The directory holding 1.jpg and 2.jpg, or null when none of the candidates has both. */
export function findFigureDir() {
  for (const dir of CANDIDATES) {
    if (!dir) continue;
    if (existsSync(join(dir, '1.jpg')) && existsSync(join(dir, '2.jpg'))) return dir;
  }
  return null;
}

/** The figures the assertions need, as absolute paths, or null. */
export function figurePaths() {
  const dir = findFigureDir();
  if (!dir) return null;
  return { dir, fig1: join(dir, '1.jpg'), fig2: join(dir, '2.jpg') };
}

/** One line explaining where the figures came from, for the suite's output. */
export function describeFixtures() {
  const dir = findFigureDir();
  return dir ? `真实题图来自 ${dir}` : `未找到真实题图；已查 ${CANDIDATES.filter(Boolean).join(' ; ')}`;
}
