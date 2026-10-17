# Test figures

The pixel-layer assertions in `tools/check.mjs` run against two real scans:

| file | what it is | why it is here |
| --- | --- | --- |
| `1.jpg` | 1536×2711, a vertical page | carries a **3×3 px, area 6** stray speck at (1124, 225) |
| `2.jpg` | 3094×1526, a landscape page | carries a **31×47 px, area 1139** stray blob at (2372, 322) — and runs at roughly twice the linear scale of `1.jpg` |

Those two marks differ by two orders of magnitude in area, and that is the point:
the speck thresholds are derived from the figure's own stroke span rather than
from the page dimensions, and this pair is what catches a threshold that was
tuned on one figure alone. An earlier fixed limit of `maxArea: 600` silently
dropped the `2.jpg` blob; a limit large enough for the blob started reporting the
letters as marks.

`7.jpg` is optional and used for the dashed-line counter-example: its dashes are
small, solid, and not attached to anything, so a detector without run detection
offers nine fake objects to the model.

## They are not in this repository

They are pages from someone else's exam paper, so they are not redistributed
here. `tools/fixtures.mjs` resolves them in this order:

1. `READ_FIGURE_FIXTURES` — an explicit directory, for CI or another checkout
2. `<repo>/fixtures/` — where you drop your own copies
3. `../output/力学_第二章_动力学基础_测试_解答/figures/` — the working tree this
   plugin was built against

If none of them has both files, the suite reports the pixel-layer checks as
**skipped** rather than passing them. A skipped check is honest; a silently
passing one is not.

## Running the suite without them

Everything except section 5 (image-header parsing) and the real-figure half of
the pixel-layer section runs on synthetic fixtures generated in-process, so
`npm run check` is still meaningful in a bare checkout: the JPEG decoder is
exercised on the real entropy stream only when a real file is present.
