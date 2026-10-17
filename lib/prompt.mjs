// Prompt assets.
//
// The protocol is the part of this plugin that carries the value, so it lives in
// a plain markdown file a user can read and edit without touching code. The
// loader resolves it relative to this module, and falls back to the packaged
// default: a customized copy in the workspace must never be required for the
// tool to work.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = resolve(HERE, '..');
export const DEFAULT_PROMPT_FILE = join(PACKAGE_ROOT, 'prompts', 'figure-handoff.zh.md');

/**
 * Resolve the protocol text.
 *
 * @param {object} config normalized config
 * @returns {{ text: string, path: string }}
 */
export function loadProtocol(config, { readFile = readFileSync } = {}) {
  const path = config?.promptFile ? resolve(config.promptFile) : DEFAULT_PROMPT_FILE;
  let text;
  try {
    text = readFile(path, 'utf8');
  } catch (err) {
    if (path === DEFAULT_PROMPT_FILE) {
      throw new Error(`read-figure: 打包的协议文件读不出来：${path}（${err?.message ?? err}）`);
    }
    throw new Error(
      `read-figure: config.promptFile 指向的协议文件读不出来：${path}（${err?.message ?? err}）。` +
        `留空则用打包的默认协议：${DEFAULT_PROMPT_FILE}`,
    );
  }
  if (!text.trim()) throw new Error(`read-figure: 协议文件是空的：${path}`);
  if (config?.extraInstruction) {
    text = `${text}\n\n──────────── 本次追加要求 ────────────\n${config.extraInstruction.trim()}`;
  }
  return { text, path };
}

/**
 * The user turn for a first-pass transcription of one or more figures.
 *
 * `label` may be a single string naming the set, or one string per image. Both
 * shapes are accepted because the CLI collects `--label` per occurrence while a
 * model naturally sends one label for one request.
 *
 * `problemText`, when supplied, is the most valuable input this tool can get: the
 * reader of the handoff cannot see the figure, and the figure alone can never
 * carry the given values (a figure shows `m₁`, not `5 kg`) or the stated conditions
 * ("smooth", "light pulley"). Passing the statement also lets the vision model
 * check figure against text — which is exactly where a misread figure gets caught.
 */
/**
 * Render one figure's pixel scan as text for the vision model.
 *
 * This exists because the model cannot measure. Asked for the size of a dark
 * blip it will answer in confident pixel numbers that are wrong by hundreds of
 * pixels, and a wrong coordinate is worse than no coordinate: it reads as
 * measured fact. These numbers come from connected-component analysis on the
 * decoded scan, so they are exact.
 *
 * Every line here is written to survive being believed. The model is told what
 * was found and explicitly forbidden to turn it into physics: the whole point of
 * the exercise is that a stray dot must not become a mass point or a hinge.
 *
 * @param {object|null} scan result of findSpecks, or null if the scan failed
 * @param {number} index which image, when several are being described
 * @param {number} total total images
 */
export function buildScanSection(scan, index = 0, total = 1) {
  const heading =
    total > 1
      ? `\n\n──────────── 第 ${index + 1} 张图的机械像素扫描结果 ────────────\n`
      : '\n\n──────────── 机械像素扫描结果 ────────────\n';
  if (!scan) return '';

  const rules =
    '使用规则（务必遵守）：\n' +
    '- 这些数字是程序测出来的**精确值**，请直接采用，不要用你自己的目测估计去覆盖它。\n' +
    '- 程序只能判断「这块墨是否孤立、多大、多深」，**不能判断它是不是题目的一部分**。\n' +
    '  到底算噪点还是算标注点，仍然由你结合图形上下文判断，并把理由写进「三、不确定」。\n' +
    '- **无论结论是什么，都不许因为这里列出的任何一块墨而新增质点、铰点、节点或滑轮。**\n' +
    '  如果某块墨挨着线条、或与别的标注构成一排，那它多半是题目的组成部分。\n';

  if (!scan.specks.length && !scan.dashRuns.length) {
    return (
      heading +
      '程序对整张图做了连通域分析：**没有发现任何 3 像素以上的游离墨块**。\n' +
      '也就是说，你在这张图上看到的每一个深色记号，都与图形的线条相连、或属于成排的虚线。\n' +
      '- 若你觉得自己看到了一个孤立的小黑点，请据实写出，但必须说明它是程序没测到的细小痕迹。\n' +
      '- 不要因为「程序说没有」就否认你确实看到的东西；也不要凭空补一个。\n'
    );
  }

  let out = heading + '程序对整张图做了连通域分析，把与线条不相连的深色墨块逐块列出：\n';
  scan.specks.forEach((b, i) => {
    out +=
      `${i + 1}. 位置约在图像横向 ${(b.normX * 100).toFixed(0)}%、纵向 ${(b.normY * 100).toFixed(0)}%` +
      `（图面${b.zone}区；像素中心 (${b.x}, ${b.y})）；尺寸 ${b.width}×${b.height} 像素，面积 ${b.area} 像素；` +
      `最深处灰度 ${b.peakInk}/255（周围纸面约 ${b.paperLevel}）\n`;
  });
  out += rules;
  if (scan.dashRuns.length) {
    const d = scan.dashRuns
      .map(
        (r) =>
          `约 ${r.count} 段、沿${r.vertical ? '竖直' : '水平'}方向排列（中心约 (${r.x}, ${r.y})，每段约 ${r.width}×${r.height} 像素）`,
      )
      .join('；');
    out +=
      `另外，程序识别出成排的短墨段，判定为**虚线**而不是游离墨块：${d}。\n` +
      '虚线是中线、隐藏轮廓或辅助线的画法，请按虚线描述，不要当成一个个独立质点。\n' +
      '注意：本程序识别虚线靠「大小相近 + 等间距 + 共线」。**虚线-点线（一长一短相间）可能只被识别出一部分**，\n' +
      '未列入的短段仍可能出现在你的视野里，请据实描述它们，不要遗漏也不要放大。\n';
  }
  if (scan.clipped.length) {
    out += `另有 ${scan.clipped.length} 处墨块紧贴图像边缘，判断为扫描裁切残留，**不是图上的记号**，此处不再列出。\n`;
  }
  return out;
}

export function buildTranscribeRequest({ label, images, imageInfo, problemText, scans }) {
  const labels = Array.isArray(label) ? label : label ? [label] : [];
  const nameFor = (i) => labels[i] ?? (labels.length === 1 ? labels[0] : undefined);
  const statement = typeof problemText === 'string' && problemText.trim() ? problemText.trim() : '';
  const scanAt = (i) => (Array.isArray(scans) ? buildScanSection(scans[i] ?? null, i, images.length) : '');

  const statementPart = statement
    ? `\n\n──────────── 题面文字（请一并转写并核对）────────────\n${statement}\n` +
      '请把上面这段题面文字也纳入交接件，并且**专门核对图与文字是否一致**：\n' +
      '- 文字提到的构件/标号，图里是否都有？文字没提、图里却有的构件也要写出来。\n' +
      '- 图与文字若有任何**冲突**（标号对不上、构件多一个少一个、条件与画法矛盾），\n' +
      '  必须写进「三、不确定」并明说冲突在哪。**冲突是最高价值的发现，不要为了让两者一致而调和它。**\n'
    : '';

  if (images.length === 1) {
    const one = imageInfo[0];
    const named = labels[0] ? `本题号/图名请用：${labels[0]}。` : '本题号/图名请你按图上的题号自行判断，判断不出就写「图」。';
    return (
      `请把下面这一张题图转写成一份「识图交接件」。${named}\n` +
      `（该图实测 ${one.width}×${one.height} 像素，文件 ${(one.bytes / 1024).toFixed(0)} KB。` +
      '凡涉及「某个黑点/黑块有多大」的判断，请按真实像素量级描述。）' +
      scanAt(0) +
      statementPart
    );
  }

  const prefixes = images.map((_, i) => `${i + 1}) ${nameFor(i) ?? `第 ${i + 1} 张（题号请你按图上标注自行判断）`}`);
  const sizes = imageInfo.map((im, i) => `${i + 1}) ${im.width}×${im.height} 像素，${(im.bytes / 1024).toFixed(0)} KB`);
  return (
    `请对下面 ${images.length} 张题图逐张转写成交接件，每张各出一份，按顺序依次是：\n` +
    `${prefixes.join('；\n')}。\n` +
    '各图实测像素尺寸：\n' +
    `${sizes.join('\n')}\n` +
    '请为每张图单独起一个「## <题号/图名>」小节，不要合并成一份。' +
    scanAt(0) +
    statementPart
  );
}

/** The user turn for a follow-up: answer this one question, do not rewrite. */
export function buildFollowUpRequest({ question, label }) {
  const head = label ? `【${label} 的定向追问】` : '【定向追问】';
  return (
    `${head}只回答下面这一条，不要重写整份交接件。\n\n` +
    `问题：${question}\n\n` +
    '要求：\n' +
    '1. 给出你的判断；\n' +
    '2. 给出依据——在图上的哪个位置、看到了什么形状/线条/像素量级；\n' +
    '3. 若两种读法都说得通，明说「两种读法都合理」，并分别写出各自会导致什么物理图景的差别；\n' +
    '4. 不要给物理推导或数值结果。'
  );
}

/** The five execution notes handed to the text-only model together with the handoff. */
export const EXECUTION_NOTES = `## 给纯文本模型的执行说明（请一并遵守）

1. 上面是**图像的结构化转述**，你没有原图。**不要凭常识补图**；凡本文件未写明的几何关系或标注，请直接说明「转述中未给出」并列为待确认项，不要默认补齐。
2. 按你自己的物理解题流程完整推导，**符号解优先**，数值代入集中在一处。
3. 若你发现**某一结论依赖于上面「不确定」那几条中的任何一条**（例如需要图上有额外的点、铰、约束），**必须停下来指出**，而不是假设。
4. 若需要更细的局部信息（例如某段绳是否打结、某面是否粗糙、箭头朝向），请**提出具体的追问清单**（问「哪一处、两种可能读法分别是什么」），由看图模型回图确认后再继续。
5. 出题人/阅卷人身份要求：最终答案在推导句内收口，分支情况必须写区间，\`g\` 跟随题给值。`;
