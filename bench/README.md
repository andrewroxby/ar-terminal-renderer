# Benches

No dependencies; each is `node bench/<name>.ts [--quick]`. They draw into
private cache directories and private tmux servers and clean up after
themselves.

| Bench | Measures |
| --- | --- |
| `transform.ts` | `Renderer.transform` per call: warm, streaming (a message growing 24 characters a call), cold in a fresh process, and tmux detection |
| `pi.ts` | A real Pi: the extension's load time, and what Pi's transforms cost while it resumes a 20-reply session (`pi-probe.ts` logs each call) |
| `nvim.ts` | Headless Neovim: time until a note's formulas are all drawn, rescan cost, cursor-move cost (`nvim.lua` is its body) |
| `load.ts` | Time and RSS the renderer adds to a process, then MathJax, then Mermaid |

## Budgets

| Budget | Result |
| --- | --- |
| Warm transform of a 20 KB message ≤ 1 ms | 0.001 to 0.011 ms; growing message 0.06 ms median at 100 KB |
| Cold sync work ≤ 300 ms (the raster budget) | 250 ms for 3 text figures, 210 ms for 12 math blocks, now cut off at the budget |
| No typing lag in Neovim | cursor move 0.01 ms, rescan after an edit 0.2 ms (1 ms with 200 formulas) |
| Extension load ≤ 50 ms | 10 ms module import, 0 to 1 ms factory. First load after Pi's loader cache is gone (a purged `$TMPDIR`): 150 to 170 ms, all Pi transpiling the TypeScript |

## Before and after

Measured on one M-series Mac, medians (p95 in the bench output), ms unless noted.

| | Before | After |
| --- | --- | --- |
| **Pi transform, unchanged message (20 KB)** | | |
| 3 figures / 12 math blocks | 0.039 / 0.049 | 0.001 / 0.002 |
| 100 KB, 12 math | 0.141 | 0.002 |
| **Pi transform, growing message, per call (100 KB, 12 math)** | 0.059 | 0.062 |
| **First transform in a new process, 12 math blocks** | | |
| renderer cache empty (sync / total) | 205 / 205 | 208 / 208 |
| PNGs cached from an earlier run | 67 | 3.6 |
| **Pi resume of 20 replies, time in transforms** | | |
| 3 figures each, empty cache | 5087 | 261 |
| 12 math each, empty cache | 3011 | 312 |
| 12 math each, PNGs cached (first / second pass) | 287 / 187 | 33 / 0 |
| **tmux lookup on the render path** (once per 2 s) | 3.3 ms blocking | 0.8 ms (the spawn; the answer lands later) |
| **Per-process memory and time** | | |
| first math block, PNGs cached | +21 MB, 46 ms | +10 MB, 2 ms (MathJax never loads) |
| first Mermaid diagram, layout cached | +61 MB, 205 ms | +10 MB, 0 ms (no worker) |
| **Neovim, note with N display + N inline formulas** | | |
| N = 20, cold cache: all drawn | 3553 | 428 |
| N = 20, warm cache | 3353 | 141 |
| N = 100, cold cache | 18698 | 1577 |
| N = 100, warm cache | 17433 | 191 |

## Where the time went

- **Neovim**: one `node core/cli.ts tex` per formula and per shrink pass,
  about 120 ms each, three at a time, even for a formula whose PNG was cached
  (the CLI had to convert it with MathJax to find the cache key). Now one
  `serve` process answers them.
- **Pi, cold**: rsvg-convert costs ~10 ms for a path-only image (math) but
  80 to 100 ms for one with `<text>` (every figure and diagram), almost all of
  it font setup in a fresh process. A resumed transcript gave every message its
  own 300 ms budget; the budget is now shared across a burst, so the rest of the
  figures render in the background.
- **Pi, resume with a warm PNG cache**: every new process converted every
  formula again (MathJax load 45 ms plus 2 ms each) to derive the cache key,
  and the per-block memo (128 entries) thrashed on transcripts with more blocks
  than that. Conversions are cached on disk, and a finished message is kept by
  its text.
- **Not a cost**: scanning and hashing on a warm path, which was already
  0.05 to 0.14 ms for 100 KB.

## Left alone

- `rsvg-convert` spawns per image stay. There is no light replacement without a
  native dependency, and 10 ms is small next to the rest. Text figures pay 80 to
  100 ms for font setup in each rsvg process. `PANGOCAIRO_BACKEND=fc` with a
  fontconfig file that prefers Helvetica and Menlo cuts that to ~50 ms with the
  same look, but the file would be macOS-specific, so it is not adopted.
- The extension's first load after Pi's loader cache is purged is Pi
  transpiling about 4000 lines of TypeScript.
