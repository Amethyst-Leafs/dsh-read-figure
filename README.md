# read-figure

Give a **text-only model** a pair of eyes — and a fixed contract for what those eyes must report.

`read-figure` is a DeepSeek Harness (DSH) plugin that contributes exactly one tool, `read_figure`:

> Hand it the path of a figure on disk → it asks a vision model to transcribe that figure under a
> **fixed three-section protocol** → it returns the transcription as **plain text** in your context →
> you answer from it.

It does not solve the problem for you, and it should not. It does something narrower and much harder
to get right: **making "what is in this figure" clear enough to be quoted, challenged, and audited.**

---

## Why this exists

DSH can already send an *attached* image to a vision-capable model. What nobody had done is this:

- A text-only model (say `deepseek-v4-pro`) that is **given an image path** can neither see the
  image nor ask anyone who can to look at it.
- Even with a transcription, there is **no contract for its quality** — the reader cannot tell what
  was genuinely observed from what was guessed.
- Scanned exam figures routinely contain **stray black specks connected to nothing**. A human
  dismisses them as scanner noise at a glance. A text-only model cannot see the image, so it reads
  the speck as a particle, a hinge, or a label symbol — and **invents a mass that does not exist,
  invalidating the entire force analysis.**

That last point is why this plugin exists. One CPhO figure carries an isolated **3×3 px ink blob,
6 px in area**, in its upper-right corner; the problem statement itself warns
"treat it as scanner noise, not a particle." That warning is exactly what a model which cannot see
the image most needs, and most easily misses.

---

## What it produces

A fixed three-section handoff whose headings are reproduced verbatim:

```markdown
# 识图交接件 · 第 1 题

> 由 read-figure 自动生成，视觉模型 `deepseek-flash`，<timestamp>.
> 源图：`figures/1.jpg`（1536×2711px，183 KB）
> 分工：图像描述与复述由看图模型完成，物理解答由纯文本模型完成。**本文件不含任何解答。**

---

### 一、图的结构（逐项描述）
Connections → every component and its label → geometry and coordinate system. No vague wording.

### 二、复述
One paragraph of physical situation, then three lists: given / sought / conditions not in the figure.

### 三、⚠ 读图置信度声明
- **高置信**：…
- **不确定**：an isolated speck about 6×10 px at the upper right, touching no line,
  judged to be scanner noise. **If you are the text-only model reading this:
  do not introduce an extra particle or hinge because of it.**

---

## 给纯文本模型的执行说明（请一并遵守）
1. Do not fill in the figure from common sense …
2. Prefer a symbolic solution …
3. If a conclusion depends on an "uncertain" item, stop and say so …
4. Ask a follow-up list …
5. Close the answer inside the derivation sentence …
```

The protocol body is **a markdown file** (`prompts/figure-handoff.zh.md`), not strings buried in code.
Edit it directly, or point `promptFile` / `extraInstruction` at your own version —
**70% of this plugin's value is the protocol, not the few hundred lines of HTTP code.**

---

## Install

### 1. Let the plugin manager do it (recommended — this is how the repo was verified)

Ask the agent to call `plugin_manager`, or use the equivalent CLI package operation:

```
plugin_manager install_bundle  https://github.com/Amethyst-Leafs/dsh-read-figure
plugin_manager install_bundle  ./path/to/read-figure        # a local directory, for development
```

`install_bundle` runs `pnpm add` against the profile and appends the row declared in
`cordis.patch.yml` to the profile's bundle stack — **no hand-editing of profile files**.

**Restart dsh afterwards.** Host plugins mount when the process starts, so `read_figure` only
appears after a restart. (Measured on the desktop profile: the second install returned
`application: restart-required`, i.e. nothing failed at mount time. The first attempt returned
`failed` because this package's `Config` was not a Standard Schema yet.)

### 2. Manual mount

Add one row to the profile's `cordis.patch.yml`:

```yaml
- id: read-figure
  name: read-figure
  config:
    model: deepseek-flash
    apiKey: sk-…            # see "Credentials" below
```

### 3. Not installed at all (zero-install evaluation)

The CLI and the plugin share every code path, so you can judge the protocol before mounting anything:

```bash
node bin/read-figure.mjs --img figures/1.jpg --img figures/2.jpg --out out/handoff.md
```

---

## Configuration

| Key | Default | Notes |
| --- | --- | --- |
| `baseUrl` | `https://api.deepseek.com` | any OpenAI-compatible `/chat/completions` endpoint |
| `model` | `deepseek-flash` | vision model name |
| `apiKey` | `''` | when empty, `READ_FIGURE_API_KEY` then `DEEPSEEK_API_KEY` |
| `maxTokens` | `8000` | **do not set this low**: a reasoning vision model spends it on its thinking chain first, and an exhausted budget returns an empty answer |
| `reasoningEffort` | `high` | `low` / `high` / `max` |
| `timeoutMs` | `180000` | per-request timeout |
| `promptFile` | `''` | empty uses the packaged `prompts/figure-handoff.zh.md` |
| `extraInstruction` | `''` | appended after the protocol, for every call in the session |
| `handoffDir` | `''` | when set, `outPath` must resolve inside it |
| `writeHandoff` | `false` | reserved: write by default |

### Credentials

A **running** DSH cannot see a shell variable exported after it started.
If an environment variable does not take effect, write `apiKey` directly into the `cordis.patch.yml` row.

---

## Using the tool

### First pass

```json
{ "imagePath": "output/…/figures/1.jpg", "label": "第 1 题" }
```

Several figures: `{"imagePaths": ["figures/1.jpg", "figures/2.jpg"], "label": "第 1、2 题"}`

### Directed follow-up

When the handoff lists an uncertainty, **do not re-run the whole transcription** — ask about it:

```json
{
  "imagePath": "figures/1.jpg",
  "question": "The longest rope hanging from B's left side — does it end at m₂ or m₃? What difference would each reading make?"
}
```

A follow-up answers that one question only, and requires the vision model to cite **position and
observed shape/pixel magnitude**. If both readings are defensible it says so, and states what
physical picture each one implies.

---

## Design notes

- **Transcribe only, never reason.** The first hard rule of the protocol is "absolutely no problem
  solving." The moment the vision model starts computing, the handoff stops being an auditable
  observation record and degrades into an answer of unknown quality that the reader can neither
  verify nor challenge.
- **Uncertainty must be listed explicitly, with a guard sentence.** Reporting "there is a speck here"
  is itself **dangerous**: without "it is noise, do not add a particle for it," a text-only model will
  take it as real. Hence the protocol demands all five parts: position, pixel size, judgement,
  reasoning, and the guard sentence.
- **False positives are more dangerous than misses.** This comes from measurement: a mechanical
  speck detector's first run reported 7 candidates on one figure, all at `x≈1` or `y≈1` — cropped
  black edges of the scan. Injected as-is, the model would believe the problem has 7 extra labels.
  **Any mechanical evidence must pass a false-positive suppression rule before an LLM sees it.**
- **Thresholds do not scale with resolution.** It is tempting to scale the pixel threshold by image
  size. Don't. `figures/2.jpg`'s stray blob (area 1139) sits squarely *between* the letterforms
  (`figures/1.jpg`'s "A" is 871, `figures/2.jpg`'s "M" is 6756) — **no area cut separates blob from
  letter.** What separates them is *small and solid*: the letters are either ≥ 70 px in one dimension
  or hollow (fill ratio ≤ 0.47). A regression test pins this: a ceiling tuned to 1.jpg (area ≤ 600)
  drops 2.jpg's blob entirely.
- **Sizes come from the file header.** "How big is that speck" is a citable fact in the handoff, so
  pixel dimensions are read from the JPEG/PNG header — never taken on a caller's word, and never from
  a native dependency like sharp that may not be installed.
- **Mechanical evidence is stated as a candidate, not a verdict.** The prompt says the scanner *found
  these marks and cannot tell whether they are deliberate*, and that a mark not connected to the
  drawing may still have been drawn on purpose. Handing a model a machine verdict it cannot appeal is
  how you turn a false positive into a fabricated particle.
- **One shared pipeline, two doors.** Both the tool and the CLI call `lib/describe-figure.mjs`, so a
  protocol change is made once.
- **No client half.** The tool result is plain text, which every conversation surface already renders,
  so no client bundle is needed.
- **One source of truth for defaults.** `lib/index.mjs` builds its Loader `Config` schema from
  `DEFAULTS` rather than restating the values. A hand-copied second copy drifted once — the schema said
  `maxTokens: 8000` while the normalizer said 32000 — and because the schema default is what an empty
  `config` resolves to, that drift made a fresh install return an *empty handoff*. The bundle row is
  asserted against `DEFAULTS` for the same reason.

---

## Does it actually work?

The point of the plugin is that a model **which cannot see images** can solve a figure problem anyway.
So that is what was measured, on a CPhO figure pair (fixed pulley + movable pulley; block on a wedge):

| Step | Model | Result |
| --- | --- | --- |
| Transcribe the figure | `deepseek-flash` (vision) | 45–78 s, 12–15 k output tokens (~70–80 % thinking) |
| Solve from the handoff alone | `deepseek-v4-pro` (**text only**) | both problems correct, verified independently |

`deepseek-v4-pro` has `input_modalities: ["text"]` — no vision whatsoever. Working from the handoff
alone it returned, for the pulley problem, `a₁ = 0.2 m/s²` downward and pulley B `0.2 m/s²` upward,
with `T = 48 N` and `T′ = 24 N`; and for the wedge, `a_B = mg sinθcosθ/(M + m sin²θ)` with
`N_table = Mg(M+m)/(M + m sin²θ)` = 68.17 N. Every one of those was checked here against an
independently derived Newtonian **and** Lagrangian solution.

Two things that measurement taught:

- **Direction is the weak point.** The magnitudes came back right; the *sign convention* for the wedge
  came back mirrored, because a text-only reader has no way to check an orientation against the
  picture. A handoff that leaves "which end is low" implicit is a handoff that will be read backwards.
- **A hypothesis in the handoff is not evidence.** Asked twice about one block's shape, the vision
  model twice said "triangular"; pixel-level inspection showed a rectangle. Asking again **reinforced**
  the misreading rather than correcting it. For anything checkable by cropping and zooming, crop and
  zoom — and let `lib/scan.mjs` supply the numbers.

---

## Marketplace compatibility

The package is a normal DSH bundle (`dsh.bundle.patch`) **and** ships a `dsh-plugin.json` conforming to
the published manifest schema *DSH Plugin Manifest Community Draft v0.15*.

```bash
npm run validate:manifest            # fetch the schema and validate
node tools/validate-manifest.mjs --offline   # use the committed copy
```

The manifest needed a decision worth noting: the schema's `id` is a **namespaced id** matching
`^[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*)+$`, which requires at least one separator. A bare
`read-figure` is therefore **not legal**; this package uses `read-figure.tool`. The manifest's
`facets.host.entry` is asserted to equal `package.json`'s `exports["."]`, so the market's idea of what
this plugin loads and the runtime's cannot diverge.

---

## Development

```bash
node bin/read-figure.mjs --self-check         # offline: protocol assembly, config, write boundary
node tools/check.mjs                          # 175 contract assertions, incl. manifest + end-to-end
node tools/validate-manifest.mjs --offline    # real JSON Schema validation of dsh-plugin.json
node tools/selftest-types-check.mjs           # prove section 13 is not a vacuous assertion (below)
npm run lint                                  # syntax check every shipped JS file
```

`lib/index.d.ts` is **hand-written**: the implementation is plain ESM JavaScript, and the file exists so a
consumer (and the harness's own tooling) can see the shape without reading the source. Hand-written means
it drifts, and it **did** drift — in both directions at once. It declared `defaults`, `DEFAULTS`,
`probeImage`, `decodeGray`, `decodeGrayPng` and `findSpecks`, none of which `lib/index.mjs` has ever
re-exported, while silently omitting twelve exports that do exist. The first kind is worse than having no
declarations at all: TypeScript accepts the import, the editor autocompletes it, and the value is
`undefined` at run time with **nothing failing in between**.

So section 13 compares the declaration's export names against the **live** exports of `lib/index.mjs`, in
both directions, and separates values from type-only names — `interface` and `type` are erased at run time
and promising them costs nothing, while `const`, `function` and `class` are promises. It compares names,
not types (a text parser cannot judge a type), but it catches renames, deletions, and unkept promises,
which is what actually went wrong.

`tools/selftest-types-check.mjs` is the **mutation test** for that section: it extracts section 13 out of
`check.mjs` and runs it against a scratch copy with five kinds of drift injected (a phantom declaration, a
rename, a deleted declaration, a deleted runtime export, and `DEFAULTS` renamed), requiring every one to
be caught and the unmutated pair to stay green. It deliberately **writes nothing inside the repository**:
a self-test that rewrites tracked files and restores them loses those files if it is interrupted between
the writes, and a self-test that can corrupt the repository it tests is not a self-test.

The end-to-end assertion starts a **local HTTP stub server** and runs `execute` for real, checking the
request body (model, `max_tokens`, `reasoning_effort`, data URL) and the assembled text. **No network.**

Section 10 of `tools/check.mjs` drives the pixel layer with **synthetic figures** encoded on the spot
by `tools/png-fixture.mjs`, whose dimensions and positions are known, so "a 6×6 blob must be reported
as 6×6" is assertable. It also pins the stray-mark coordinates and areas of the two real problem
figures — they differ by two orders of magnitude, **so a mis-tuned ceiling would let exactly one of
them pass**, which is why both are in the test.

## License

MIT
