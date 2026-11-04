# ar-term-render

Draws SVG and PNG pictures and typeset math in a terminal. `core/` is the
host-neutral engine (no Pi imports), with a CLI; `pi/` is the Pi adapter,
`arπ-render`; `nvim/` is the Neovim adapter, `ar-term-render.nvim`.

Draws, in assistant messages: closed ```` ```svg ```` fences, standalone
`![caption](/abs/path.png)` lines, ```` ```mermaid ```` fences and `$$…$$` /
`\[…\]` display math. Design and phases: the vault note
`Projects/Tooling/implementation/Inline Figures.md`.

## How it works

- `scan` finds closed top-level fences and PNG lines (fence-aware, nested
  fences and unclosed ones are skipped).
- `sanitizeSvg` caps size at 200 KB, adds `xmlns`/`viewBox`, strips external
  `href`s and CSS `url()`/`@import`.
- `rsvg-convert` rasterizes onto a card, letterboxed to whole cells, cached
  under `$TMPDIR/ar-term-render/` (7-day expiry). The card is a rect in a
  wrapper SVG, with the figure nested on it, so the page stays transparent
  to the left of the card.
- Card figures sit 2 cells in from the left and display math 3, as
  transparent space inside the image, because Markdown strips leading spaces
  from a paragraph. `AR_TERM_RENDER_INDENT` and `AR_TERM_RENDER_MATH_INDENT`
  (integers 0-8) override them. A block drops the indent whenever keeping it would shrink
  the figure, which is when the pane is too narrow for the figure at its
  natural size. Inside a list item the visual indent adds to the list's.
- Kitty `a=T,U=1` transmit, each escape wrapped for tmux passthrough
  (`\ePtmux;`, doubled ESC) when `$TMUX` is set. A local viewer
  (`graphics=file`) gets one `t=f` escape carrying the cached PNG's path;
  others get 4096-byte chunks sent under a cross-process lock in the cache
  directory (continuation chunks carry no id; the Neovim adapter takes the
  same lock). `AR_TERM_RENDER_TRANSPORT` forces `inline` or `file`. The
  Markdown gets Unicode placeholder rows whose foreground color is the image
  id. No terminal queries are ever sent.
- Availability: `tmux show -gv @viewer` (`graphics=file|inline` draws), else
  the tmux client terminal, else Ghostty/kitty outside tmux.
  `AR_TERM_RENDER_IMAGES=0|1` overrides. Fallback text is `[figure: title]` or
  `[image: alt - path]`.

Rendering is budgeted. Synchronous work (conversion and rsvg) stays within
~300 ms: no new render starts with less than 100 ms left, a started one is cut
off at what remains, and the budget refills after 500 ms without sync work, so
a burst of messages (a resumed transcript) shares one budget. Whatever misses
it shows its fallback text and renders in the background, three at a time, and
the Pi adapter asks the TUI to rebuild as they land. rsvg failures are
remembered as `<key>.fail` in the cache for 7 days.

What Pi's repeated rebuilds cost is kept small on purpose. Pi runs the
transformer again for every message on each theme, colour or readiness change,
and a transcript holds the same text many times. A finished message is kept by
its text (128 messages, 4 M characters), so the repeat is a map lookup; a
message still growing, or waiting on a render, or carrying a PNG line (whose file
can change under the same text) is not kept. Graphics detection and the cell
size are looked up with tmux once, then refreshed in the background
(`prime()` does the first lookup at session start), so no tmux command runs
inside a frame after the first.

Conversions are cached on disk as well as PNGs: `s-<key>.json` holds the SVG a
formula or Mermaid diagram converted to, keyed on the inputs and the bundle's
size and mtime, so a new process (or a resumed session) that meets a known
formula never loads MathJax and a known diagram never starts the layout worker.
Bench numbers: `bench/README.md`.

## Math and Mermaid

- **Display math** (`$$…$$` or `\[…\]` opening a line, closing a line, no
  blank line between; never inline `$…$`) goes through MathJax 3
  (`mathjax-full`, chosen over MathJax 4's `@mathjax/src` because its CJS
  `js/` tree bundles with esbuild in one command and runs DOM-free through
  `liteAdaptor`). Packages: base, ams, boldsymbol, mathtools, physics, cancel,
  color, upgreek, textmacros. Commands that define or redefine macros
  (`\newcommand`, `\def`, `\DeclareMathOperator`, `\definecolor` and the
  like) are left out, because MathJax keeps definitions for the life of the
  process; a block that uses one keeps its text. Math is drawn without a card,
  in the theme's text color, at 0.8 em per cell height (about the size of the
  terminal's own letters).
  `\tag{n}` becomes trailing text. Up to 12 per message.
- **Mermaid** goes through `beautiful-mermaid` onto the card (catppuccin-mocha
  palette). Layout runs in a worker thread with a 2 s limit, and sources over
  300 edges or 150 nodes are refused, so no diagram can stall the host. The
  fence shows as text until its picture is ready. Its SVG uses CSS variables and `color-mix()`, which librsvg
  ignores, so `core/cssvars.ts` resolves them first. It supports flowchart,
  sequence, state, class, ER and xychart; anything else is left for Pi's own
  Unicode Mermaid.
- Where graphics are off or rendering fails, math and mermaid fences are left
  exactly as written, so cellmath and Pi draw them as before. Only svg and png
  blocks fall back to `[figure: …]` / `[image: …]`.
- The libraries are bundled by `npm run build` into `core/vendor/*.cjs`
  (committed) and loaded lazily with `createRequire`, so no `node_modules`
  is needed at runtime. `npm test` rebuilds them first.

## CLI

```
ar-term-render tex [--display|--inline] [--color #hex] [--background #hex] [--em-px N] [--scale N] [--padding N] [--cell WxH] [-o FILE] [LATEX]
ar-term-render svg [--background #hex] [--scale N] [--padding N] [-o FILE]   # SVG on stdin
ar-term-render mermaid [--card #hex] [--scale N] [--padding N] [-o FILE]     # diagram on stdin
ar-term-render demo [FILE]                                                   # draw Markdown at the terminal width
```

Writes a PNG (the cached file, or `-o`) and prints its path; exit 1 with a
short stderr message on failure, 2 on bad usage. It runs on Node 22.18+ or
24.2+ (type stripping and `import.meta.main`) and exits 1 naming that
requirement on anything older. Each run sweeps cache files older than 7 days
once a day. `tex` is transparent, colour `#d4d4d4` by default. `--em-px N` sets one em in device pixels (default 64;
Pi's display math is `0.8 x` cell height), and `--cell WxH` pads the PNG to
whole cells with the formula at the left and centered vertically, the way Pi
lays out display math, so a terminal can show it without stretching.
`--padding` is in logical pixels, which `--scale` (default 2) turns into
device pixels. A run costs node's start (~40 ms) plus, for a formula never seen,
MathJax's load (~45 ms), its conversion (~2 ms) and rsvg (~10 ms); a repeat of a
known formula loads no MathJax and spawns no rsvg.

`serve` is the same engine as one long-lived process, for an editor that draws
many formulas. It reads one JSON object per line on stdin and answers one per
line on stdout, in the order renders finish:

```
{"id": 1, "tex": "x^2", "display": true, "color": "#d4d4d4", "emPx": 64, "cell": "9x20"}
{"id": 1, "path": "/tmp/ar-term-render/<key>.png"}
{"id": 2, "error": "could not typeset that LaTeX", "rejected": true}
```

Fields besides `id` and `tex` are the `tex` options (`display`, `color`,
`background`, `emPx`, `cell` as `WxH`, `scale`, `padding`). `rejected` means the
input was refused for good; without it the run failed and may pass later. It
runs up to four rsvg processes at once, exits when stdin closes and after ten
idle minutes (`AR_TERM_RENDER_IDLE_MS` shortens that, for tests).

`demo` runs the real Renderer over FILE (default `core/demo.md`: an SVG, a wide
and a tall Mermaid diagram, two math blocks and a code block) at the terminal
width minus one. It waits for background renders, writes the image data, then
prints the transformed Markdown (prose stays raw) and exits, leaving the images
on screen. Compare indents with `AR_TERM_RENDER_INDENT=3 ar-term-render demo`
(or `AR_TERM_RENDER_MATH_INDENT` for math).
The sample has no PNG line, because the renderer draws at most three figures
per message.

## Pi

Load with `pi -e ~/dev/ar-term-render/pi/index.ts` (nothing is installed into
settings). `/render on|off|redraw|status`. A `tmux wait-for viewer-changed`
watcher resends images when tmux-viewer reports a new client. When graphics
are available, `before_agent_start` appends one guidance line
(`core/guidance.ts`) to the system prompt.

## Neovim

`nvim/` is a Neovim plugin that draws LaTeX math in Markdown buffers without
touching the file. Display math (`$$…$$`, `\[…\]`, and ```` ```math ```` fences)
and inline math (`$…$`, `\(…\)`) is replaced by the render, and the cursor
line always shows the source. Fences, `` `code` `` spans, table rows and
currency such as `$5 and $10` are left alone.

Install it from the checkout with lazy.nvim, which adds the directory to the
runtime path:

```lua
{
  dir = vim.fn.expand("~/dev/ar-term-render/nvim"),
  name = "ar-term-render.nvim",
  ft = "markdown",
  config = function()
    require("ar_term_render").setup()
  end,
}
```

On a terminal that speaks kitty graphics (kitty, Ghostty, herdr, or tmux
under either), math is typeset as an image by the renderer's `tex` engine, sized
from the terminal's cell pixels like Pi: display math at 0.8 em per cell
height, left-aligned `display_indent` columns in, shrinking to fit the window
(width less two, at most 100 columns, as in Pi) and dropping the indent first.
Display math is never shrunk below 0.5 em per cell height, as in Pi; past that
the text stays. Inline math is drawn at 0.7 em and must fit one row. Images
are transmitted inline, so they reach remote clients, and are re-sent when the
view changes or another program clears them. Everywhere else,
and for math an image cannot carry (inline math needing more than one row,
fractions and matrices inline, TeX the renderer rejects), the plugin draws
Unicode text with the `cellmath` CLI, as Pi and Claude Code do. cellmath does
not wrap, so display art wider than the window stays as source. If the
renderer is missing, everything draws as cellmath text.

Requirements: Neovim (tested on 0.12), Node 22.18+ or 24.2+ and `rsvg-convert`
for images, `cellmath` on `PATH` for text. The renderer is `ar-term-render` on
`PATH`, else `core/cli.ts` in this checkout; on an older Node the plugin warns
once and draws cellmath text. The PNGs stay in the renderer's own cache,
`$TMPDIR/ar-term-render`, which Pi shares; the plugin remembers their paths for
the session.

The plugin starts one `ar-term-render serve` process on the first formula and
sends it a request line per image, so a formula costs a message instead of a
node start, a MathJax load and an rsvg spawn (about 120 ms each before). The
process restarts if it dies with work in flight, exits on its own after ten idle
minutes, and is killed on `VimLeavePre`. A renderer without `serve`, or one
that cannot start, falls back to one run per formula by itself, as does
`persistent = false`. Graphics detection under tmux and the node version check
run in the background, so nothing blocks the editor after the first lookup.

Whether images draw follows Pi: `AR_TERM_RENDER_IMAGES=0|1`, then
tmux's `@viewer` line (re-read every 2 s), then the client terminal, and it
needs `termguicolors`, because the image id travels in a foreground colour.
`:colorscheme` redraws the math, since it clears those colours.

Options for `setup()` (defaults shown):

```lua
{
  filetypes = { "markdown" },
  images = true,         -- false forces cellmath text
  debounce = 300,        -- ms of quiet before a buffer is rescanned
  display_indent = 3,    -- columns in from the text start (AR_TERM_RENDER_MATH_INDENT, 0-8, wins)
  display_align = "left", -- "center" ignores display_indent
  resend = true,         -- re-upload images that were cleared
  resend_every = 3000,   -- ms between backstop re-uploads (paused while unfocused); 0 for none
  display_em = 0.8,      -- em size in cell heights: display start, display floor, inline
  display_em_floor = 0.5,
  inline_em = 0.7,
  ar_term_render = "ar-term-render", -- renderer command, else this checkout's core/cli.ts
  node = "node",
  persistent = true,     -- one long-lived renderer process; false runs it once per formula
  cellmath = "cellmath",
  fallback_cell = { w = 9, h = 20 }, -- cell pixels when the tty reports none
}
```

`:ArRender [toggle|on|off|render]` controls the current buffer. Other
plugins can ask for a re-upload with `User ArRenderResend`, as the yazi
column does after yazi erases its image preview. `setup()` can run again; each
call starts from the defaults. The backstop re-upload sleeps on `FocusLost` and
wakes on `FocusGained`, so tmux needs `focus-events on`.

## Tests

`npm test` runs the type check and the node:test suites, including a pty test
against a private tmux server. `npm run test:nvim` runs the plugin's plenary
specs headless; it needs `nvim` with `plenary.nvim` installed through lazy,
and each group skips itself when its programs are missing.
`node bench/transform.ts`, `bench/pi.ts`, `bench/nvim.ts` and `bench/load.ts`
measure the speed budgets (see `bench/README.md`).
`python3 pi/test/live-check.py` runs a live Pi in a private tmux server
(`-L figproto`) with a cheap Fireworks model; it needs `rsvg-convert`, `tmux`
and API keys in `~/.pi/agent/auth.json`.
