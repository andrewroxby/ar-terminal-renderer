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
import { mermaidToSvg } from './mermaid.ts'
import { sanitizeSvg } from './svg.ts'
import type { Layout } from './layout.ts'
import { defaultCacheDir, lookup, render } from './raster.ts'

// V8 caches the compiled MathJax bundle between runs.
if (import.meta.main) {
  try {
    enableCompileCache(join(defaultCacheDir(), 'v8'))
  } catch {}
}

const USAGE = `usage: ar-term-render tex [--display | --inline] [--color #hex] [--background #hex]
                          [--size N] [--scale N] [--padding N] [-o FILE] [LATEX]
       ar-term-render svg [--background #hex] [--scale N] [--padding N] [-o FILE]   (SVG on stdin)
       ar-term-render mermaid [--card #hex] [--scale N] [--padding N] [-o FILE]     (diagram on stdin)

Writes a PNG and prints its path. LATEX is read from stdin when not given.
tex: transparent background, default color #cdd6f4. --size is a font size in
logical pixels (default 32, as termtex-img's -s) and --scale the device pixel
ratio (default 2), so one em is size x scale x 1.83 pixels. svg and mermaid
draw at --scale pixels per drawing unit. --padding is in logical pixels.`

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

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

// Rasterizes at `unit` pixels per drawing unit, padded, and returns the path.
function toPng(svg: CleanSvg, unit: number, pad: number, bg: string | null, out: string | undefined): string {
  const fitW = Math.max(1, Math.round(svg.vw * unit))
  const fitH = Math.max(1, Math.round(svg.vh * unit))
  const layout: Layout = {
    cols: 0,
    rows: 0,
    fitW,
    fitH,
    pxW: fitW + 2 * pad,
    pxH: fitH + 2 * pad,
    left: pad,
    top: pad,
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

export function main(argv: string[]): string {
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

  if (cmd === 'tex') {
    if (values.display && values.inline) throw new Fail('--display and --inline conflict', 2)
    const tex = (rest.length ? rest.join(' ') : readStdin()).trim()
    if (!tex) throw new Fail('no LaTeX given', 2)
    const size = num('--size', values.size, 32)
    const color = hex('--color', values.color, '#cdd6f4')!
    const bg = hex('--background', values.background, null)
    const clean = mathToSvg(tex, color, !values.inline)
    if (!clean) throw new Fail('could not typeset that LaTeX')
    return toPng(clean, (size * scale * TERMTEX_EM) / 1000, pad, bg, values.output)
  }
  if (cmd === 'svg') {
    const clean = sanitizeSvg(readStdin())
    if (!clean) throw new Fail('not a usable SVG (missing <svg>, or over 200 KB)')
    return toPng(clean, scale, pad, hex('--background', values.background, null), values.output)
  }
  if (cmd === 'mermaid') {
    const card = hex('--card', values.card, '#1e1e2e')!
    const clean = mermaidToSvg(readStdin(), card)
    if (!clean) throw new Fail('unsupported or invalid Mermaid diagram')
    return toPng(clean, scale, pad, card, values.output)
  }
  throw new Fail(cmd ? `unknown command ${cmd}` : 'no command given', 2)
}

if (import.meta.main) {
  try {
    process.stdout.write(main(process.argv.slice(2)) + '\n')
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
