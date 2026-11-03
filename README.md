# ar-term-render

Draws SVG and PNG pictures inline in a terminal transcript. `core/` is the
host-neutral engine (no Pi imports); `pi/` is the Pi adapter, `arπ-render`.

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
  under `$TMPDIR/ar-term-render/` (7-day expiry).
- Kitty `a=T,U=1` transmit, each escape wrapped for tmux passthrough
  (`\ePtmux;`, doubled ESC) when `$TMUX` is set. A local viewer
  (`graphics=file`) gets one `t=f` escape carrying the cached PNG's path;
  others get 4096-byte chunks sent under a cross-process lock in the cache
  directory (continuation chunks carry no id). `AR_TERM_RENDER_TRANSPORT`
  forces `inline` or `file`. The Markdown gets
  Unicode placeholder rows whose foreground color is the image id. No
  terminal queries are ever sent.
- Availability: `tmux show -gv @viewer` (`graphics=file|inline` draws), else
  the tmux client terminal, else Ghostty/kitty outside tmux.
  `AR_TERM_RENDER_IMAGES=0|1` overrides. Fallback text is `[figure: title]` or
  `[image: alt - path]`.

Rendering is budgeted: past ~300 ms per transform, remaining figures show
their fallback text and render in the background (async), and the Pi adapter
asks the TUI to rebuild when they are ready. rsvg failures are remembered as
`<key>.fail` in the cache for 7 days.

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
  terminal's own letters), indented two cells.
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
ar-term-render tex [--display|--inline] [--color #hex] [--background #hex] [--size N] [--scale N] [--padding N] [-o FILE] [LATEX]
ar-term-render svg [--background #hex] [--scale N] [--padding N] [-o FILE]   # SVG on stdin
ar-term-render mermaid [--card #hex] [--scale N] [--padding N] [-o FILE]     # diagram on stdin
```

Writes a PNG (the cached file, or `-o`) and prints its path; exit 1 with a
short stderr message on failure, 2 on bad usage. `tex` is transparent, colour
`#cdd6f4` by default, and `--size` / `--scale` match termtex-img's `-s` at
device scale 2 (one em is size x scale x 1.83 pixels), so Neovim's termtex can
call it in place of `termtex-img`. A cache miss takes about 120 ms (node 40,
MathJax load and conversion 40, rsvg 10, TS and argument handling the rest).

## Pi

Load with `pi -e ~/dev/ar-term-render/pi/index.ts` (nothing is installed into
settings). `/render on|off|redraw|status`. A `tmux wait-for viewer-changed`
watcher resends images when tmux-viewer reports a new client. When graphics
are available, `before_agent_start` appends one guidance line
(`core/guidance.ts`) to the system prompt.

## Tests

`npm test` runs the type check and the node:test suites, including a pty test
against a private tmux server. `python3 pi/test/live-check.py` runs a live Pi
in a private tmux server (`-L figproto`) with a cheap Fireworks model; it needs
`rsvg-convert`, `tmux` and API keys in `~/.pi/agent/auth.json`.
