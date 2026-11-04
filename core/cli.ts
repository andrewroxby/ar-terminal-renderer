#!/usr/bin/env node
// The ar-term-render command line: PNGs of display math, SVG and Mermaid
// through the same MathJax / beautiful-mermaid / rsvg-convert path and cache
// as the Pi adapter. The PNG path goes to stdout.

import { copyFileSync, readFileSync } from 'node:fs'
import { enableCompileCache } from 'node:module'
import { join } from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { MERMAID_TIMEOUT_MS, MermaidRunner } from './mermaid.ts'
import { sanitizeSvg } from './svg.ts'
import { runDemo } from './demo.ts'
import { defaultCacheDir, lookup, render, sweepDaily, type RasterOptions } from './raster.ts'
import { serve } from './serve.ts'
import { DEFAULT_EM_PX, Fail, canvas, hex, num, parseCell, texCanvas } from './tex.ts'

// import.meta.main arrived in the same Node releases (22.18, 24.2) that run
// .ts files without a flag. Anything older would skip main() and exit 0 with
// no output, so it fails here instead.
if (import.meta.main === undefined) {
  process.stderr.write(`ar-term-render: needs Node 22.18+ or 24.2+ (this is ${process.version})\n`)
  process.exit(1)
}

// V8 caches the compiled MathJax bundle between runs.
if (import.meta.main) {
  try {
    enableCompileCache(join(defaultCacheDir(), 'v8'))
  } catch {}
}

const USAGE = `usage: ar-term-render tex [--display | --inline] [--color #hex] [--background #hex]
                          [--em-px N] [--scale N] [--padding N] [--cell WxH] [-o FILE] [LATEX]
       ar-term-render svg [--background #hex] [--scale N] [--padding N] [-o FILE]   (SVG on stdin)
       ar-term-render mermaid [--card #hex] [--scale N] [--padding N] [-o FILE]     (diagram on stdin)
       ar-term-render demo [FILE]       (draw a Markdown file at the terminal's width)
       ar-term-render serve             (answer tex requests, one JSON line each, until stdin closes)

Writes a PNG and prints its path. LATEX is read from stdin when not given.
tex: transparent background, default color #d4d4d4. --em-px sets one em in
device pixels (default 64), and --cell WxH pads the image to whole cells of that
pixel size, formula at the left and centered vertically, as Pi lays out display
math. svg and mermaid draw at --scale pixels per drawing unit. --padding is in
logical pixels, which --scale (default 2) turns into device pixels.
serve reads {"id", "tex", "display", "color", "emPx", "cell":"WxH"} lines on stdin and
answers {"id", "path"} or {"id", "error", "rejected"}; it exits after 10 idle minutes.
demo prints FILE (default: a bundled sample) through the renderer, leaving the
images on screen; AR_TERM_RENDER_INDENT=0-8 sets the figures' left indent in cells and
AR_TERM_RENDER_MATH_INDENT=0-8 the display math's.`

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

// Rasterizes the canvas and returns the path, or copies it to `out`.
function toPng(o: RasterOptions, out: string | undefined): string {
  sweepDaily(o.cacheDir)
  const hit = lookup(o)
  const path = hit.state === 'hit' ? hit.path : hit.state === 'miss' ? render(o) : null
  if (!path) throw new Fail('rendering failed (is rsvg-convert installed?)')
  if (!out) return path
  copyFileSync(path, out)
  return out
}

async function main(argv: string[]): Promise<string> {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        display: { type: 'boolean' },
        inline: { type: 'boolean' },
        color: { type: 'string', short: 'c' },
        background: { type: 'string' },
        card: { type: 'string' },
        'em-px': { type: 'string' },
        cell: { type: 'string' },
        scale: { type: 'string' },
        padding: { type: 'string', short: 'p' },
        output: { type: 'string', short: 'o' },
        help: { type: 'boolean', short: 'h' },
      },
    })
  } catch (e) {
    throw new Fail((e as Error).message, 2)
  }
  const { values, positionals } = parsed
  if (values.help) throw new Fail(USAGE, 0)
  const [cmd, ...rest] = positionals
  const scale = num('--scale', values.scale, 2)
  const pad = Math.round(num('--padding', values.padding, 0) * scale)
  if (scale <= 0) throw new Fail('--scale must be positive', 2)

  if (cmd === 'demo') {
    await runDemo(rest[0])
    return ''
  }
  if (cmd === 'tex') {
    if (values.display && values.inline) throw new Fail('--display and --inline conflict', 2)
    const tex = rest.length ? rest.join(' ') : readStdin()
    const o = texCanvas(
      { tex, display: !values.inline, color: values.color, background: values.background, emPx: num('--em-px', values['em-px'], DEFAULT_EM_PX), cell: values.cell, scale, padding: num('--padding', values.padding, 0) },
      defaultCacheDir(),
    )
    return toPng(o, values.output)
  }
  if (cmd === 'svg') {
    const clean = sanitizeSvg(readStdin())
    if (!clean) throw new Fail('not a usable SVG (missing <svg>, or over 200 KB)')
    return toPng(canvas(clean, scale, pad, hex('--background', values.background, null), defaultCacheDir()), values.output)
  }
  if (cmd === 'mermaid') {
    const card = hex('--card', values.card, '#1e1e2e')!
    // The worker is unref'd, so this timer keeps the process up while it runs.
    const hold = setTimeout(() => {}, MERMAID_TIMEOUT_MS + 1000)
    const runner = new MermaidRunner()
    const r = await runner.run(readStdin(), card)
    runner.close()
    clearTimeout(hold)
    if (r.state === 'timeout') throw new Fail(`Mermaid diagram took longer than ${MERMAID_TIMEOUT_MS / 1000} s to lay out`)
    if (r.state === 'missing') throw new Fail('the Mermaid bundle is missing (run npm run build)')
    if (r.state !== 'ok') throw new Fail('unsupported or invalid Mermaid diagram')
    return toPng(canvas(r.svg, scale, pad, card, defaultCacheDir()), values.output)
  }
  if (cmd === 'serve') {
    // AR_TERM_RENDER_IDLE_MS shortens the idle exit, for tests.
    const idleMs = Number(process.env.AR_TERM_RENDER_IDLE_MS)
    await serve(process.stdin, process.stdout, { cacheDir: defaultCacheDir(), idleMs: idleMs > 0 ? idleMs : undefined })
    return ''
  }
  throw new Fail(cmd ? `unknown command ${cmd}` : 'no command given', 2)
}

if (import.meta.main) {
  try {
    const out = await main(process.argv.slice(2))
    if (out) process.stdout.write(out + '\n')
  } catch (e) {
    if (e instanceof Fail) {
      if (e.code === 0) process.stdout.write(USAGE + '\n')
      else process.stderr.write(`ar-term-render: ${e.message}\n${e.code === 2 ? USAGE + '\n' : ''}`)
      process.exitCode = e.code
    } else {
      process.stderr.write(`ar-term-render: ${(e as Error).message}\n`)
      process.exitCode = 1
    }
  }
}
