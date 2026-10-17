// Mechanical evidence layer: find isolated ink blobs ("specks") in a figure by
// connected-component analysis, so the handoff can state position and pixel size
// as MEASURED FACTS instead of asking a vision model to estimate them.
//
// Why this exists at all (measured, not assumed): on figures/1.jpg the vision
// model missed a 3x3-pixel isolated dot entirely, and when asked again it
// reported a different location and size. On figures/2.jpg it called the apex
// dot confidently but with the wrong coordinates. A model that cannot see a
// 6-pixel feature cannot be asked to bound it; a model that CAN see it still
// cannot produce a pixel-exact coordinate. Both are mechanical answers.
//
// The danger this layer is designed around is the OPPOSITE of missing a speck:
// a false positive is worse than a miss, because a text-only reader treats the
// handoff as ground truth and will happily invent a particle or a hinge from a
// blob that is really a scan artifact. tools/check.mjs pins both directions.

const NB8 = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];

export const SPECK_DEFAULTS = {
  // Below 3 px is JPEG ringing around a stroke, not a mark someone drew.
  minArea: 3,
  // The bounds below are calibrated on the two real scans in this workspace and
  // are deliberately generous enough to catch BOTH of their stray dots, which
  // differ by two orders of magnitude because one page is scanned at twice the
  // linear scale:
  //   figures/1.jpg  3x3,   area    6, fill 0.67
  //   figures/2.jpg  31x47, area 1139, fill 0.78
  // What separates those two dots from every other component is not area -- the
  // 2.jpg dot (1139) sits by area between the glyph "A" (871, in 1.jpg) and the
  // glyph "M" (6756, in 2.jpg). It is being compact AND solid: every letter and
  // numeral in these figures is either large in one dimension (>= 70 px) or
  // hollow (fill <= 0.47, e.g. the 107x102 ring at fill 0.25).
  maxArea: 1200,
  maxDim: 50,
  // A solid dot fills most of its bounding box; a glyph or a ring does not.
  // Applied only past minSolidArea, so a thin stroke is judged on its size and
  // never on its fill.
  minFill: 0.55,
  minSolidArea: 20,
  // Grey level below which a pixel counts as ink.
  inkThreshold: 128,
  // A blob hugging the scan border is a cropping remnant. It is reported
  // separately and never offered as a candidate mark.
  edgeMargin: 2,
  // Local-contrast gate, relative to a high percentile of the surrounding ring:
  // peakInk must be at least this much darker than the paper it sits on.
  // Scanning noise is faint but the paper around it is clean, so a ratio in the
  // 0.2-0.5 range separates it from a JPEG ghost, which has almost none.
  minLocalContrast: 0.25,
  // The ring is summarised by percentiles, never by a mean: a neighbouring
  // speck drags a mean down and would flip the verdict on an unrelated blob.
  surroundRadius: 6,
  // Higher percentile = closer to "the paper", less sensitive to a close neighbour.
  surroundPercentile: 0.9,
  // A dashed line's dashes agree in size to within this fraction...
  runSizeTolerance: 0.25,
  // ...and sit within this many pixels of a common centre line.
  runAlignTolerance: 4,
  // Two similar blobs is a coincidence; three in a row is a dashed line.
  runMinCount: 3,
};

/**
 * Span of the drawing itself: the square root of the largest component's area.
 *
 * Reported for provenance only -- it tells a reader how coarse this scan is
 * relative to the calibrated default, so a judgement call can be revisited.
 * It deliberately does not drive the thresholds; see maxArea above.
 */
export function drawingSpan(components) {
  let biggest = 0;
  for (const c of components) if (c.area > biggest) biggest = c.area;
  return Math.sqrt(biggest);
}

/** Nine-cell compass word for a coordinate, for readers who think in layout. */
function zone(x, y, w, h) {
  const col = x < w / 3 ? '左' : x < (2 * w) / 3 ? '中' : '右';
  const row = y < h / 3 ? '上' : y < (2 * h) / 3 ? '中' : '下';
  return `${row}${col}`;
}

/**
 * Label 8-connected components of the ink mask.
 * Iterative flood fill: a recursive one blows the stack on a full-page stroke.
 */
function components(mask, w, h) {
  const seen = new Uint8Array(w * h);
  const out = [];
  const stack = [];
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || seen[start]) continue;
    seen[start] = 1;
    stack.length = 0;
    stack.push(start);
    let area = 0;
    let minx = start % w;
    let maxx = minx;
    let miny = (start / w) | 0;
    let maxy = miny;
    while (stack.length) {
      const p = stack.pop();
      area++;
      const x = p % w;
      const y = (p / w) | 0;
      if (x < minx) minx = x;
      if (x > maxx) maxx = x;
      if (y < miny) miny = y;
      if (y > maxy) maxy = y;
      for (let n = 0; n < 8; n++) {
        const nx = x + NB8[n][0];
        const ny = y + NB8[n][1];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (mask[q] && !seen[q]) {
          seen[q] = 1;
          stack.push(q);
        }
      }
    }
    out.push({ area, minx, miny, maxx, maxy });
  }
  return out;
}

/**
 * Percentile of the luminance in a ring around a bounding box (excluding it).
 *
 * A high percentile answers "how bright is the paper here", which is the only
 * baseline a local contrast can honestly be measured against. A mean answers
 * "how bright is everything nearby", which a second speck or a passing stroke
 * will corrupt.
 */
function surroundPercentile(gray, w, h, bbox, radius, pct) {
  const x0 = Math.max(0, bbox.minx - radius);
  const x1 = Math.min(w - 1, bbox.maxx + radius);
  const y0 = Math.max(0, bbox.miny - radius);
  const y1 = Math.min(h - 1, bbox.maxy + radius);
  const vals = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (x >= bbox.minx && x <= bbox.maxx && y >= bbox.miny && y <= bbox.maxy) continue;
      vals.push(gray[y * w + x]);
    }
  }
  if (!vals.length) return 0;
  vals.sort((a, b) => a - b);
  return vals[Math.min(vals.length - 1, Math.floor(pct * vals.length))];
}

/**
 * Scan a decoded grey plane for isolated ink blobs.
 *
 * @param {{width:number,height:number,data:Uint8Array}} image
 * @param {object} [options] overrides for SPECK_DEFAULTS
 * @returns {{width:number,height:number,componentCount:number,bigCount:number,
 *            inkTotal:number,bigInk:number,specks:object[],clipped:object[],
 *            faint:object[],thresholds:object}}
 */
export function findSpecks(image, options = {}) {
  const { width: w, height: h, data: gray } = image;
  // The ink mask depends only on inkThreshold, which is scale independent, so it
  // can be built before the scale is known. The component list is what tells us
  // the scale: the dominant stroke network is the largest component.
  const mask = new Uint8Array(w * h);
  let inkTotal = 0;
  const inkThreshold = options.inkThreshold ?? SPECK_DEFAULTS.inkThreshold;
  for (let i = 0; i < w * h; i++) {
    if (gray[i] < inkThreshold) {
      mask[i] = 1;
      inkTotal++;
    }
  }

  const comps = components(mask, w, h);
  const spanPx = drawingSpan(comps);
  const opt = { ...SPECK_DEFAULTS, ...options };

  let bigCount = 0;
  let bigInk = 0;
  for (const c of comps) {
    if (c.area > opt.maxArea) {
      bigCount++;
      bigInk += c.area;
    }
  }

  const specks = [];
  const clipped = [];
  const faint = [];
  const hollow = [];
  for (const c of comps) {
    const bw = c.maxx - c.minx + 1;
    const bh = c.maxy - c.miny + 1;
    if (c.area < opt.minArea || c.area > opt.maxArea) continue;
    if (bw > opt.maxDim || bh > opt.maxDim) continue;
    const cx = (c.minx + c.maxx) >> 1;
    const cy = (c.miny + c.maxy) >> 1;

    // Darkest pixel in the blob: the single best discriminator between a drawn
    // mark and a JPEG ghost, and it costs one pass over the bounding box.
    let peakInk = 255;
    for (let y = c.miny; y <= c.maxy; y++) {
      for (let x = c.minx; x <= c.maxx; x++) {
        const v = gray[y * w + x];
        if (v < peakInk) peakInk = v;
      }
    }
    const paper = surroundPercentile(gray, w, h, c, opt.surroundRadius, opt.surroundPercentile);
    // How much darker the blob is than the paper it sits on, as a fraction of
    // that paper level. Scale-free, so it survives a light or dark scan.
    const contrast = paper > 0 ? 1 - peakInk / paper : 0;
    const rec = {
      area: c.area,
      width: bw,
      height: bh,
      x: cx,
      y: cy,
      bbox: [c.minx, c.miny, c.maxx, c.maxy],
      zone: zone(cx, cy, w, h),
      fill: Math.round((c.area / (bw * bh)) * 100) / 100,
      normX: Math.round((cx / w) * 1000) / 1000,
      normY: Math.round((cy / h) * 1000) / 1000,
      peakInk,
      paperLevel: paper,
      contrast: Math.round(contrast * 1000) / 1000,
    };

    const atEdge =
      c.minx <= opt.edgeMargin ||
      c.miny <= opt.edgeMargin ||
      c.maxx >= w - 1 - opt.edgeMargin ||
      c.maxy >= h - 1 - opt.edgeMargin;
    if (atEdge) {
      // Cropping remnant: listed, but never offered as a candidate mark.
      clipped.push(rec);
      continue;
    }
    if (contrast >= opt.minLocalContrast) {
      // Solid enough to be a mark rather than a hollow glyph or a ring? The
      // fill gate only applies once a blob is big enough for its fill ratio to
      // mean anything; at 3 px every shape is solid.
      if (c.area < opt.minSolidArea || rec.fill >= opt.minFill) {
        specks.push(rec);
      } else {
        // A hollow blob this small: recorded so the decision is auditable, but
        // not offered as a candidate.
        hollow.push(rec);
      }
    } else {
      // Found by geometry but rejected as too faint: keep it visible so a
      // reader can tell "nothing there" apart from "something was filtered".
      faint.push(rec);
    }
  }

  // A dash in a dashed line is small and solid -- geometrically the same thing
  // as a stray dot. What separates them is being one of a repeated series, so
  // the series has to be detected before anything is offered as a stray mark.
  const { runs, strays } = splitDashRuns(specks, opt);

  const byArea = (a, b) => b.area - a.area || a.y - b.y || a.x - b.x;
  strays.sort(byArea);
  clipped.sort(byArea);
  faint.sort(byArea);
  hollow.sort(byArea);
  return {
    width: w,
    height: h,
    componentCount: comps.length,
    bigCount,
    inkTotal,
    bigInk,
    specks: strays,
    dashRuns: runs,
    clipped,
    faint,
    hollow,
    thresholds: {
      minArea: opt.minArea,
      maxArea: opt.maxArea,
      maxDim: opt.maxDim,
      inkThreshold: opt.inkThreshold,
      edgeMargin: opt.edgeMargin,
      minLocalContrast: opt.minLocalContrast,
      drawingSpanPx: Math.round(spanPx),
      surroundRadius: opt.surroundRadius,
      surroundPercentile: opt.surroundPercentile,
      runMinCount: opt.runMinCount,
    },
  };
}

/**
 * Separate dashed-line strokes from genuinely stray marks.
 *
 * A dashed centreline or hidden edge is drawn as a sequence of short solids. In
 * figures/7.jpg the vertical axis through A and C accounts for five of them and
 * the horizontal centre line for four more, every one of which is small and
 * solid enough to pass the speck filters. Offering those to a reader as
 * "isolated dots, probably scan noise" would be worse than saying nothing: it
 * invents nine objects in a figure that has none.
 *
 * The test is repetition. Dashes of one line agree closely in size and spacing
 * and sit on a common centre line; a stray dot has no partners. Blobs are
 * therefore grouped only when all three hold, and a group needs at least
 * `runMinCount` members before it is called a dashed line -- two similar blobs
 * is a coincidence, not a pattern.
 *
 * @param {object[]} blobs candidate marks, as produced above
 * @returns {{runs: object[], strays: object[]}}
 */
function splitDashRuns(blobs, opt = SPECK_DEFAULTS) {
  const minCount = opt.runMinCount;
  const sizeTol = opt.runSizeTolerance;
  const alignTol = opt.runAlignTolerance;
  const near = (a, b) => Math.abs(a - b) <= Math.max(a, b) * sizeTol;

  const used = new Set();
  const runs = [];
  for (let i = 0; i < blobs.length; i++) {
    if (used.has(i)) continue;
    // Grow a group around blob i, one candidate at a time, so that a chain of
    // dashes links up even if the ends differ by more than the tolerance.
    const group = [i];
    used.add(i);
    let grew = true;
    while (grew) {
      grew = false;
      for (let j = 0; j < blobs.length; j++) {
        if (used.has(j)) continue;
        const fits = group.some((g) => {
          const a = blobs[g];
          const b = blobs[j];
          const similar = near(a.width, b.width) && near(a.height, b.height) && near(a.area, b.area);
          if (!similar) return false;
          // Same column (vertical dashes) or same row (horizontal dashes).
          return Math.abs(a.x - b.x) <= alignTol || Math.abs(a.y - b.y) <= alignTol;
        });
        if (fits) {
          group.push(j);
          used.add(j);
          grew = true;
        }
      }
    }
    if (group.length >= minCount) {
      const members = group.map((g) => blobs[g]);
      runs.push({
        count: members.length,
        members,
        vertical: Math.max(...members.map((m) => m.x)) - Math.min(...members.map((m) => m.x)) <= alignTol,
        x: Math.round(members.reduce((s, m) => s + m.x, 0) / members.length),
        y: Math.round(members.reduce((s, m) => s + m.y, 0) / members.length),
        width: Math.round(members.reduce((s, m) => s + m.width, 0) / members.length),
        height: Math.round(members.reduce((s, m) => s + m.height, 0) / members.length),
      });
    }
  }
  const inRun = new Set();
  for (const r of runs) for (const m of r.members) inRun.add(m);
  return { runs, strays: blobs.filter((b) => !inRun.has(b)) };
}

/** One-line summary for provenance lines and logs. */
export function summarizeScan(scan) {
  if (!scan) return '扫描未执行';
  return `游离墨块 ${scan.specks.length} 处（边缘截断 ${scan.clipped.length}、弱对比已滤除 ${scan.faint.length}）`;
}

/**
 * Render the scan as the block that goes into the vision request.
 *
 * The wording is load-bearing. It must (a) hand over positions as measurements
 * the model cannot be expected to improve on, (b) forbid the model from
 * promoting a clipped or filtered blob into a physical object, and (c) never
 * say "there is no noise" -- only "this scan found none", which is a claim
 * about the scan, not about the drawing.
 */
export function formatScanForPrompt(scans) {
  const list = Array.isArray(scans) ? scans : [scans];
  const lines = [
    '## 机械像素扫描结果（由程序测量，不是你的目测）',
    '',
    '下面是程序对同一张图做连通域分析得到的**精确**结果。位置、像素尺寸、',
    '灰度都是测出来的，请**直接采用这些数字**，不要用自己的估计替换或"修正"它们。',
    '你的任务是判断这些墨块的**物理含义**，不是重新测量。',
    '',
  ];
  for (const entry of list) {
    const { label, scan } = entry;
    lines.push(`### ${label}`);
    if (!scan) {
      lines.push('', '（该图无法做像素级扫描，只能依赖你的目视观察。）', '');
      continue;
    }
    const t = scan.thresholds;
    lines.push(
      '',
      `- 图像 ${scan.width}×${scan.height}px；连通域 ${scan.componentCount} 个` +
        `（其中大图形 ${scan.bigCount} 个，占墨迹 ${scan.inkTotal ? ((100 * scan.bigInk) / scan.inkTotal).toFixed(2) : '0'}%）`,
      `- 判据：面积 ${t.minArea}~${t.maxArea}px、外接框 ≤ ${t.maxDim}px、灰度 < ${t.inkThreshold} 记为墨、` +
        `距边界 ≤ ${t.edgeMargin}px 记为截断`,
    );
    if (scan.specks.length === 0) {
      // A statement about the scan, never about the figure.
      lines.push(
        `- **本次扫描未筛出游离墨块**。这表示"按上述判据没找到"，不等于"图上绝对没有"；` +
          `若你目视发现可疑孤立墨块，请照实写进「三、不确定」，并标注这是你的目视而非机械测量。`,
      );
    } else {
      lines.push(`- **筛出游离墨块 ${scan.specks.length} 处**（位置与尺寸为机械测量值）：`, '');
      lines.push('| # | 方位 | 中心 (x,y) | 归一化位置 | 外接尺寸 | 面积 | 填充率 | 最暗灰度 | 周围纸面灰度 | 局部对比度 |');
      lines.push('|---|---|---|---|---|---|---|---|---|---|');
      scan.specks.forEach((s, i) => {
        lines.push(
          `| ${i + 1} | ${s.zone} | (${s.x}, ${s.y}) | (${s.normX}, ${s.normY}) | ` +
            `${s.width}×${s.height} | ${s.area} | ${s.fill} | ${s.peakInk} | ${s.paperLevel} | ${s.contrast} |`,
        );
      });
      lines.push(
        '',
        '请对每一处给出判断，并写进交接件的「三、⚠ 读图置信度声明 · 不确定」，' +
          '格式为「位置 + 像素尺寸 + 判断 + 为什么这么判」。',
        '若判为扫描噪点，必须**逐字**写下这一句：' +
          '「**若纯文本模型看到本条，请勿据此引入额外质点或铰点。**」',
      );
    }
    if (scan.clipped.length) {
      lines.push(
        '',
        `> 另有 **${scan.clipped.length}** 处墨块贴着图像边界（距边界 ≤ ${t.edgeMargin}px），` +
          `属扫描裁切残留，**不得**当作图中的标注、质点或铰点：` +
          scan.clipped
            .slice(0, 6)
            .map((s) => `${s.width}×${s.height}@(${s.x},${s.y})`)
            .join('、') +
          (scan.clipped.length > 6 ? ' 等' : ''),
      );
    }
    if (scan.faint.length) {
      lines.push(
        '',
        `> 另有 **${scan.faint.length}** 处小连通域因局部对比过弱（对比度最高仅 ` +
          `${Math.max(...scan.faint.map((s) => s.contrast))}，低于判据 ${scan.thresholds.minLocalContrast}）` +
          `被判为压缩伪影，未计入游离墨块：` +
          scan.faint
            .slice(0, 6)
            .map((s) => `${s.width}×${s.height}@(${s.x},${s.y})`)
            .join('、') +
          (scan.faint.length > 6 ? ' 等' : ''),
      );
    }
    lines.push('');
  }
  lines.push(
    '---',
    '',
    '注意：以上是**机械证据**，不是结论。若机械扫描与你的目视观察不一致，' +
      '**请把不一致本身写进「三、不确定」**（各写各的，不要为了让两者一致而调和）。',
  );
  return lines.join('\n');
}
