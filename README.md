# ar-term-render

Draws SVG and PNG pictures inline in a terminal transcript. `core/` is the
host-neutral engine (no Pi imports); `pi/` is the Pi adapter, `arπ-render`.

Phase 1: closed ```` ```svg ```` fences and standalone `![caption](/abs/path.png)`
lines in assistant messages. Design and phases: the vault note
`Projects/Tooling/implementation/Inline Figures.md`.

## How it works

- `scan` finds closed top-level fences and PNG lines (fence-aware, nested
  fences and unclosed ones are skipped).
- `sanitizeSvg` caps size at 200 KB, adds `xmlns`/`viewBox`, strips external
  `href`s and CSS `url()`/`@import`.
- `rsvg-convert` rasterizes onto a card, letterboxed to whole cells, cached
  under `$TMPDIR/ar-term-render/` (7-day expiry).
- Kitty `a=T,U=1` transmit in 4096-byte chunks, each wrapped for tmux
  passthrough (`\ePtmux;`, doubled ESC) when `$TMUX` is set. The Markdown gets
  Unicode placeholder rows whose foreground color is the image id. No
  terminal queries are ever sent.
- Availability: `tmux show -gv @viewer` (`graphics=file|inline` draws), else
  the tmux client terminal, else Ghostty/kitty outside tmux.
  `AR_TERM_RENDER_IMAGES=0|1` overrides. Fallback text is `[figure: title]` or
  `[image: alt - path]`.

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
