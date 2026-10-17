#!/usr/bin/env node
// read-figure CLI — the zero-install surface.
//
// This exists so the protocol can be exercised and judged before any plugin is
// mounted, and so a handoff stays reproducible by hand afterwards. It shares
// every code path with the Cordis tool, so a protocol edit needs no second fix.
//
//   node bin/read-figure.mjs --img figures/1.jpg --img figures/2.jpg --out out/handoff.md
//   node bin/read-figure.mjs --img figures/1.jpg --question "m₂ 和 m₃ 谁更低？"
//   node bin/read-figure.mjs --self-check

import { basename } from 'node:path';
import { readFileSync } from 'node:fs';
import { describeFigures, summarize } from '../lib/describe-figure.mjs';
import { normalizeConfig } from '../lib/config.mjs';
import { probeImage } from '../lib/image-size.mjs';
import { VisionError } from '../lib/vision.mjs';

const USAGE = `read-figure — 把题图交给视觉模型，取回三段式「识图交接件」

用法：
  node bin/read-figure.mjs --img <路径> [--img <路径> …] [选项]

选项：
  --img <路径>          图片路径，可重复（至少一张）
  --label <文本>        题号/图名，多图时按出现顺序各配一个
  --problem-text <文本> 题面文字（已知量数值、光滑/粗糙等条件）。图里看不到这些，强烈建议给
  --problem-file <路径> 从文件读题面文字（避免长文本在命令行里转义）
  --question <文本>     定向追问：只回答这一条，不重写整份交接件
  --out <路径>          交接件写到该文件；缺省则打到 stdout
  --model <名>          视觉模型（缺省 deepseek-flash）
  --base-url <URL>      接口地址（缺省 https://api.deepseek.com）
  --api-key <key>       直写密钥；缺省依次读 READ_FIGURE_API_KEY、DEEPSEEK_API_KEY
  --max-tokens <n>      缺省 8000；deepseek-flash 会先出思考链，给少了会空正文
  --effort <低/高>      reasoning effort：low / high / max，缺省 high
  --timeout <ms>        单次请求超时，缺省 180000
  --prompt-file <路径>  覆盖内置协议文件
  --json                结果以 JSON 输出（含出处信息）
  --self-check          离线自检：协议装配、图片头解析、配置校验，不联网
  -h, --help            显示本说明
`;

const argv = process.argv.slice(2);
if (argv.includes('-h') || argv.includes('--help') || !argv.length) {
  process.stdout.write(USAGE);
  process.exit(argv.length ? 0 : 1);
}

const flags = parseArgs(argv);

try {
  if (flags.selfCheck) await selfCheck();
  else await run(flags);
} catch (err) {
  const code = err instanceof VisionError ? 2 : 1;
  process.stderr.write(`\n✘ ${err?.message ?? err}\n`);
  if (process.env.READ_FIGURE_DEBUG) process.stderr.write(`${err?.stack}\n`);
  process.exit(code);
}

async function run(f) {
  const config = normalizeConfig({
    baseUrl: f.baseUrl,
    model: f.model,
    apiKey: f.apiKey,
    maxTokens: f.maxTokens,
    reasoningEffort: f.effort,
    timeoutMs: f.timeout,
    promptFile: f.promptFile,
  });
  const result = await describeFigures({
    images: f.img,
    label: f.label.length ? f.label : undefined,
    question: f.question,
    problemText: resolveProblemText(f),
    outPath: f.out,
    config,
  });

  if (f.json) {
    process.stdout.write(
      `${JSON.stringify({ handoff: result.handoff, provenance: result.provenance, outPath: result.outPath ?? null }, null, 2)}\n`,
    );
  } else if (f.out) {
    process.stdout.write(`✔ ${summarize(result)}\n  已写出 ${result.outPath}（${result.handoff.length} 字符）\n`);
  } else {
    process.stdout.write(`${result.handoff}\n`);
  }
  if (!f.json) {
    const u = result.provenance.usage;
    if (u) {
      const cached = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
      process.stderr.write(
        `  tokens: prompt ${u.prompt_tokens}（缓存 ${cached}）/ completion ${u.completion_tokens}` +
          `（思考 ${u.completion_tokens_details?.reasoning_tokens ?? 0}）/ 合计 ${u.total_tokens}\n`,
      );
    }
  }
}

async function selfCheck() {
  const { loadProtocol, buildTranscribeRequest, buildFollowUpRequest, EXECUTION_NOTES } = await import('../lib/prompt.mjs');
  const { composeHandoff, resolveHandoffPath } = await import('../lib/describe-figure.mjs');
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

  process.stdout.write('read-figure 自检（离线）\n');

  const proto = loadProtocol(normalizeConfig({}));
  const sections = ['一、图的结构', '二、复述', '三、⚠ 读图置信度声明'];
  ok('协议文件可读且含三段式标题', sections.every((s) => proto.text.includes(s)), basename(proto.path));
  ok('协议含「不许解题」纪律', proto.text.includes('绝对不许解题'));
  ok('协议含噪点防护句', proto.text.includes('请勿据此引入额外质点或铰点'));

  const fakeInfo = [{ path: 'a.jpg', width: 100, height: 200, bytes: 2048, format: 'jpeg' }];
  const composed = composeHandoff({
    question: '',
    answer: '### 一、图的结构（逐项描述）\n…\n### 二、复述\n…\n### 三、⚠ 读图置信度声明\n- **高置信**：…',
    labels: ['第 1 题'],
    imageInfo: fakeInfo,
    provenance: { model: 'm', generatedAt: 'now' },
  });
  ok('装配结果带题号标题', composed.includes('# 识图交接件 · 第 1 题'));
  ok('装配结果带执行说明 5 条', (composed.match(/^\d\. /gm) ?? []).length >= 5);
  ok('装配结果声明不含解答', composed.includes('本文件不含任何解答'));

  const fu = buildFollowUpRequest({ question: '两张图中的 A 是同一个物体吗？', label: '第 1 题' });
  ok('追问请求含问题原文且要求不重写', fu.includes('只回答下面这一条') && fu.includes('两张图中的 A'));

  const tr = buildTranscribeRequest({
    label: '第 1 题、第 2 题',
    images: ['a.jpg', 'b.jpg'],
    imageInfo: [...fakeInfo, { ...fakeInfo[0], path: 'b.jpg' }],
  });
  ok(
    '多图请求逐张点名且各带尺寸',
    tr.includes('1) 第 1 题、第 2 题') && tr.includes('2) 第 1 题、第 2 题') && (tr.match(/100×200 像素/g) ?? []).length === 2,
    '',
  );
  const tr2 = buildTranscribeRequest({
    label: ['第 1 题', '第 2 题'],
    images: ['a.jpg', 'b.jpg'],
    imageInfo: [...fakeInfo, { ...fakeInfo[0], path: 'b.jpg' }],
  });
  ok('多图请求支持逐张配名', tr2.includes('1) 第 1 题') && tr2.includes('2) 第 2 题'));

  ok('执行说明恰好 5 条', (EXECUTION_NOTES.match(/^\d\. /gm) ?? []).length === 5);

  try {
    resolveHandoffPath('x.md', { handoffDir: 'C:/tmp/only' });
    ok('越界写盘被拒', false, '竟然通过了');
  } catch (err) {
    ok('越界写盘被拒', /拒绝写到/.test(err.message));
  }

  try {
    normalizeConfig({ reasoningEffort: 'turbo' });
    ok('非法 effort 被拒', false);
  } catch (err) {
    ok('非法 effort 被拒', /low \/ high \/ max/.test(err.message));
  }

  const real = process.env.READ_FIGURE_SELFCHECK_IMG;
  if (real) {
    try {
      const info = probeImage(real);
      ok('真实图片头解析', info.width > 0 && info.height > 0, `${basename(real)} ${info.width}×${info.height}px ${info.format}`);
    } catch (err) {
      ok('真实图片头解析', false, err.message);
    }
  } else {
    process.stdout.write('  · 跳过真实图片头解析（设 READ_FIGURE_SELFCHECK_IMG=<图片> 可启用）\n');
  }

  process.stdout.write(`\n自检结果：${pass} 项通过，${fail} 项失败\n`);
  if (fail) process.exit(1);
}

function resolveProblemText(f) {
  const parts = [];
  if (f.problemFile) parts.push(readFileSync(f.problemFile, 'utf8').trim());
  if (f.problemText) parts.push(f.problemText.trim());
  return parts.filter(Boolean).join('\n\n') || undefined;
}

function parseArgs(list) {
  const f = { img: [], label: [], json: false, selfCheck: false };
  const take = (i, name) => {
    const v = list[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`read-figure: ${name} 后面缺少取值`);
    return v;
  };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    switch (a) {
      case '--img':
      case '--image':
        f.img.push(take(i, a));
        i++;
        break;
      case '--label':
        f.label.push(take(i, a));
        i++;
        break;
      case '--problem-text':
        f.problemText = take(i, a);
        i++;
        break;
      case '--problem-file':
        f.problemFile = take(i, a);
        i++;
        break;
      case '--question':
        f.question = take(i, a);
        i++;
        break;
      case '--out':
        f.out = take(i, a);
        i++;
        break;
      case '--model':
        f.model = take(i, a);
        i++;
        break;
      case '--base-url':
        f.baseUrl = take(i, a);
        i++;
        break;
      case '--api-key':
        f.apiKey = take(i, a);
        i++;
        break;
      case '--max-tokens':
        f.maxTokens = take(i, a);
        i++;
        break;
      case '--effort':
        f.effort = take(i, a);
        i++;
        break;
      case '--timeout':
        f.timeout = take(i, a);
        i++;
        break;
      case '--prompt-file':
        f.promptFile = take(i, a);
        i++;
        break;
      case '--json':
        f.json = true;
        break;
      case '--self-check':
        f.selfCheck = true;
        break;
      default:
        throw new Error(`read-figure: 不认识的参数 ${JSON.stringify(a)}（用 --help 看用法）`);
    }
  }
  if (!f.selfCheck && !f.img.length) throw new Error('read-figure: 至少要给一个 --img（用 --help 看用法）');
  return f;
}
