#!/usr/bin/env node
// The ar-term-render command line: PNGs of display math, SVG and Mermaid
// through the same MathJax / beautiful-mermaid / rsvg-convert path and cache
// as the Pi adapter. The PNG path goes to stdout.

import { copyFileSync, readFileSync } from 'node:fs'
import { enableCompileCache } from 'node:module'
import { join } from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import type { CleanSvg } from './svg.ts'
import { mathToSvg } from './math.ts'
import { MERMAID_TIMEOUT_MS, MermaidRunner } from './mermaid.ts'
import { sanitizeSvg } from './svg.ts'
import type { Cell, Layout } from './layout.ts'
import { runDemo } from './demo.ts'
import { defaultCacheDir, lookup, render } from './raster.ts'

// V8 caches the compiled MathJax bundle between runs.
if (import.meta.main) {
  try {
    enableCompileCache(join(defaultCacheDir(), 'v8'))
  } catch {}
}

const USAGE = `usage: ar-term-render tex [--display | --inline] [--color #hex] [--background #hex]
                          [--size N | --em-px N] [--scale N] [--padding N] [--cell WxH] [-o FILE] [LATEX]
       ar-term-render svg [--background #hex] [--scale N] [--padding N] [-o FILE]   (SVG on stdin)
       ar-term-render mermaid [--card #hex] [--scale N] [--padding N] [-o FILE]     (diagram on stdin)
       ar-term-render demo [FILE]       (draw a Markdown file at the terminal's width)

Writes a PNG and prints its path. LATEX is read from stdin when not given.
tex: transparent background, default color #cdd6f4. --size is a font size in
logical pixels (default 32, as termtex-img's -s) and --scale the device pixel
ratio (default 2), so one em is size x scale x 1.83 pixels. --em-px instead sets
one em in device pixels directly (--size and --scale then no longer size it), and
--cell WxH pads the image to whole cells of that pixel size, formula at the top
left and centered vertically, as Pi lays out display math. svg and mermaid
draw at --scale pixels per drawing unit. --padding is in logical pixels.
demo prints FILE (default: a bundled sample) through the renderer, leaving the
images on screen; AR_TERM_RENDER_INDENT=0-8 sets the figures' left indent in cells and
AR_TERM_RENDER_MATH_INDENT=0-8 the display math's.`

// Pixels of em per unit of size, matching termtex-img's -s at scale 2
// (measured: a 16-px-size formula has a 58-px em).
const TERMTEX_EM = 1.83
const MAX_PIXELS = 16_000_000
const MAX_SIDE = 10_000

class Fail extends Error {
  code: number
  constructor(message: string, code = 1) {
    super(message)
    this.code = code
  }
}

function num(name: string, v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) throw new Fail(`${name} must be a non-negative number`, 2)
  return n
}

function hex(name: string, v: string | undefined, fallback: string | null): string | null {
  if (v === undefined) return fallback
  if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) throw new Fail(`${name} must be #rgb or #rrggbb`, 2)
  return v
}

function parseCell(v: string | undefined): Cell | undefined {
  if (v === undefined) return undefined
  const m = /^(\d+)x(\d+)$/.exec(v)
  if (!m || Number(m[1]) < 1 || Number(m[2]) < 1) throw new Fail('--cell must be WxH in pixels, such as 24x48', 2)
  return { w: Number(m[1]), h: Number(m[2]) }
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

// Rasterizes at `unit` pixels per drawing unit, padded, and returns the path.
// With `cell`, the canvas grows to whole cells and the figure sits at the left,
// centered vertically.
function toPng(svg: CleanSvg, unit: number, pad: number, bg: string | null, out: string | undefined, cell?: Cell): string {
  const fitW = Math.max(1, Math.round(svg.vw * unit))
  const fitH = Math.max(1, Math.round(svg.vh * unit))
  const innerW = fitW + 2 * pad
  const innerH = fitH + 2 * pad
  const pxW = cell ? Math.ceil(innerW / cell.w) * cell.w : innerW
  const pxH = cell ? Math.ceil(innerH / cell.h) * cell.h : innerH
  const layout: Layout = {
    cols: 0,
    rows: 0,
    fitW,
    fitH,
    pxW,
    pxH,
    left: pad,
    top: pad + Math.floor((pxH - innerH) / 2),
    cardX: 0,
  }
  if (layout.pxW > MAX_SIDE || layout.pxH > MAX_SIDE || layout.pxW * layout.pxH > MAX_PIXELS) {
    throw new Fail(`image would be ${layout.pxW}x${layout.pxH} pixels, too large`)
  }
  const o = { svg: svg.svg, layout, bg, cacheDir: defaultCacheDir() }
  const hit = lookup(o)
  const path = hit.state === 'hit' ? hit.path : hit.state === 'miss' ? render(o) : null
  if (!path) throw new Fail('rendering failed (is rsvg-convert installed?)')
  if (!out) return path
  copyFileSync(path, out)
  return out
}

export async function main(argv: string[]): Promise<string> {
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
        size: { type: 'string', short: 's' },
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
    const tex = (rest.length ? rest.join(' ') : readStdin()).trim()
    if (!tex) throw new Fail('no LaTeX given', 2)
    if (values.size !== undefined && values['em-px'] !== undefined) throw new Fail('--size and --em-px conflict', 2)
    const emPx = values['em-px'] === undefined ? null : num('--em-px', values['em-px'], 0)
    if (emPx === 0) throw new Fail('--em-px must be positive', 2)
    const size = num('--size', values.size, 32)
    const cell = parseCell(values.cell)
    const color = hex('--color', values.color, '#cdd6f4')!
    const bg = hex('--background', values.background, null)
    const clean = mathToSvg(tex, color, !values.inline)
    if (!clean) throw new Fail('could not typeset that LaTeX')
    const unit = (emPx ?? size * scale * TERMTEX_EM) / 1000
    return toPng(clean, unit, pad, bg, values.output, cell)
  }
  if (cmd === 'svg') {
    const clean = sanitizeSvg(readStdin())
    if (!clean) throw new Fail('not a usable SVG (missing <svg>, or over 200 KB)')
    return toPng(clean, scale, pad, hex('--background', values.background, null), values.output)
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
    return toPng(r.svg, scale, pad, card, values.output)
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
