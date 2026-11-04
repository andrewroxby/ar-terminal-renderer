// What `tex` needs, shared by the one-shot command and `serve`: argument
// checks, the TeX-to-SVG step, and the canvas the PNG is drawn on.

import { DEFAULT_MATH } from './color.ts'
import type { Cell, Layout } from './layout.ts'
import { mathToSvg } from './math.ts'
import type { RasterOptions } from './raster.ts'
import type { CleanSvg } from './svg.ts'

export const DEFAULT_EM_PX = 64
const MAX_PIXELS = 16_000_000
const MAX_SIDE = 10_000

// code 2 is a usage error, 1 a failure, 0 asks for the usage text.
// `rejected` marks input the renderer refuses for good, as opposed to a
// failure that may pass next time.
export class Fail extends Error {
  code: number
  rejected: boolean
  constructor(message: string, code = 1, rejected = false) {
    super(message)
    this.code = code
    this.rejected = rejected
  }
}

export function num(name: string, v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) throw new Fail(`${name} must be a non-negative number`, 2, true)
  return n
}

export function hex(name: string, v: string | undefined, fallback: string | null): string | null {
  if (v === undefined) return fallback
  if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) throw new Fail(`${name} must be #rgb or #rrggbb`, 2, true)
  return v
}

export function parseCell(v: string | undefined): Cell | undefined {
  if (v === undefined) return undefined
  const m = /^(\d+)x(\d+)$/.exec(v)
  if (!m || Number(m[1]) < 1 || Number(m[2]) < 1) throw new Fail('--cell must be WxH in pixels, such as 24x48', 2, true)
  return { w: Number(m[1]), h: Number(m[2]) }
}

// The canvas for an SVG drawn at `unit` pixels per drawing unit, padded by
// `pad` device pixels. With `cell`, the canvas grows to whole cells and the
// figure sits at the left, centered vertically.
export function canvas(svg: CleanSvg, unit: number, pad: number, bg: string | null, cacheDir: string, cell?: Cell): RasterOptions {
  const fitW = Math.max(1, Math.round(svg.vw * unit))
  const fitH = Math.max(1, Math.round(svg.vh * unit))
  const innerW = fitW + 2 * pad
  const innerH = fitH + 2 * pad
  const pxW = cell ? Math.ceil(innerW / cell.w) * cell.w : innerW
  const pxH = cell ? Math.ceil(innerH / cell.h) * cell.h : innerH
  const layout: Layout = { cols: 0, rows: 0, fitW, fitH, pxW, pxH, left: pad, top: pad + Math.floor((pxH - innerH) / 2), cardX: 0 }
  if (layout.pxW > MAX_SIDE || layout.pxH > MAX_SIDE || layout.pxW * layout.pxH > MAX_PIXELS) {
    throw new Fail(`image would be ${layout.pxW}x${layout.pxH} pixels, too large`, 1, true)
  }
  return { svg: svg.svg, layout, bg, cacheDir }
}

export interface TexArgs {
  tex: string
  display?: boolean
  color?: string
  background?: string
  emPx?: number
  cell?: string
  scale?: number
  padding?: number
}

// Checks the arguments of one `tex` run and builds its canvas.
export function texCanvas(a: TexArgs, cacheDir: string): RasterOptions {
  const tex = a.tex.trim()
  if (!tex) throw new Fail('no LaTeX given', 2, true)
  const scale = a.scale ?? 2
  if (!(scale > 0)) throw new Fail('--scale must be positive', 2, true)
  const emPx = a.emPx ?? DEFAULT_EM_PX
  if (!(emPx > 0)) throw new Fail('--em-px must be positive', 2, true)
  const pad = Math.round((a.padding ?? 0) * scale)
  const color = hex('--color', a.color, DEFAULT_MATH)!
  const bg = hex('--background', a.background, null)
  const cell = parseCell(a.cell)
  const clean = mathToSvg(tex, color, a.display ?? true, cacheDir)
  if (!clean) throw new Fail('could not typeset that LaTeX', 1, true)
  return canvas(clean, emPx / 1000, pad, bg, cacheDir, cell)
}
