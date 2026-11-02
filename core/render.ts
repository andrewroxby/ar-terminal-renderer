// The renderer: turns figure blocks in a Markdown string into placeholder
// rows (transmitting the image once) or a text fallback. Pure apart from
// that one-time transmit and the cached PNG files. Host-neutral; the host
// supplies `write` and, optionally, a cell-size fallback.

import { createHash } from 'node:crypto'
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { DEFAULT_CARD } from './color.ts'
import { defaultRun, detectGraphics, tmuxCell, type Availability, type Run } from './env.ts'
import { DEFAULT_CELL, layout as computeLayout, type Cell, type Layout } from './layout.ts'
import { placeholderRows, transmit } from './kitty.ts'
import { defaultCacheDir, rasterize, sweep } from './raster.ts'
import { scan, type Block } from './scan.ts'
import { sanitizeSvg } from './svg.ts'

export const MAX_FIGURES = 3
export const MAX_PNG_BYTES = 10 * 1024 * 1024
const MEMO_TTL_MS = 2000
const MAX_RESEND = 30

export interface Options {
  write: (data: string) => void
  env?: NodeJS.ProcessEnv
  run?: Run
  cacheDir?: string
  cellFallback?: () => Cell | undefined
  card?: () => string
  now?: () => number
}

interface Drawn {
  id: number
  png: string
  cols: number
  rows: number
  lines: string[]
}

// A fence kind the renderer knows. Later phases (math, mermaid) add entries.
interface FenceKind {
  lang: string
  toSvg(body: string): { svg: string; vw: number; vh: number; title: string } | null
}

const FENCE_KINDS: FenceKind[] = [{ lang: 'svg', toSvg: sanitizeSvg }]

export class Renderer {
  enabled = true
  readonly cacheDir: string
  private o: Options
  private env: NodeJS.ProcessEnv
  private run: Run
  private now: () => number
  private langs: Set<string>
  private sent = new Set<number>()
  private known = new Map<number, Drawn>()
  private memo = new Map<string, Drawn | null>()
  private availMemo: { at: number; v: Availability } | null = null
  private cellMemo: { at: number; v: Cell } | null = null
  private nextId: number

  constructor(o: Options) {
    this.o = o
    this.env = o.env ?? process.env
    this.run = o.run ?? defaultRun
    this.now = o.now ?? Date.now
    this.cacheDir = o.cacheDir ?? defaultCacheDir()
    this.langs = new Set(FENCE_KINDS.map((k) => k.lang))
    // Random 24-bit base per process, so two processes in one terminal don't
    // overwrite each other's images. Never 0.
    this.nextId = Math.floor(Math.random() * 0xfffffe)
    sweep(this.cacheDir)
  }

  available(): Availability {
    const t = this.now()
    if (!this.availMemo || t - this.availMemo.at > MEMO_TTL_MS) {
      this.availMemo = { at: t, v: detectGraphics(this.env, this.run) }
    }
    return this.availMemo.v
  }

  cell(): Cell {
    const t = this.now()
    if (!this.cellMemo || t - this.cellMemo.at > MEMO_TTL_MS) {
      const v = (this.env.TMUX ? tmuxCell(this.run) : null) ?? this.o.cellFallback?.() ?? DEFAULT_CELL
      this.cellMemo = { at: t, v: v.w > 0 && v.h > 0 ? v : DEFAULT_CELL }
    }
    return this.cellMemo.v
  }

  transform(markdown: string, ctx: { width: number }): string {
    if (!this.enabled) return markdown
    if (!markdown.includes('```') && !markdown.includes('~~~') && !markdown.includes('![')) return markdown
    const blocks = scan(markdown, this.langs)
    if (blocks.length === 0) return markdown

    const draw = this.available().ok
    let out = markdown
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i]!
      const drawn = draw && i < MAX_FIGURES ? this.draw(b, ctx.width) : null
      const text = drawn ? drawn.lines.join('\n') : this.fallback(b)
      // Blank lines keep the rows out of a neighboring paragraph.
      const before = prevLineNonBlank(markdown, b.start) ? '\n' : ''
      const after = nextLineNonBlank(markdown, b.end) ? '\n' : ''
      out = out.slice(0, b.start) + before + text + after + out.slice(b.end)
    }
    return out
  }

  // Sends every known image again, for a client that attached late or a
  // terminal that lost its store. Returns how many were sent.
  redraw(): number {
    this.sent.clear()
    this.availMemo = null
    this.cellMemo = null
    const recent = [...this.known.values()].slice(-MAX_RESEND)
    for (const d of recent) this.send(d)
    return recent.length
  }

  status(): { enabled: boolean; available: Availability; cell: Cell; images: number; cacheDir: string } {
    return {
      enabled: this.enabled,
      available: this.available(),
      cell: this.cell(),
      images: this.known.size,
      cacheDir: this.cacheDir,
    }
  }

  private fallback(b: Block): string {
    if (b.kind === 'image') return b.alt ? `[image: ${b.alt} - ${b.path}]` : `[image: ${b.path}]`
    const kind = FENCE_KINDS.find((k) => k.lang === b.lang)
    const title = kind?.toSvg(b.body)?.title ?? ''
    return title ? `[figure: ${title}]` : '[figure]'
  }

  private draw(b: Block, width: number): Drawn | null {
    const cell = this.cell()
    const card = this.o.card?.() ?? DEFAULT_CARD
    const geom = `${width}|${cell.w}x${cell.h}|${card}`

    let key: string
    let build: () => Drawn | null
    if (b.kind === 'fence') {
      key = `f|${createHash('sha256').update(b.lang + '\0' + b.body).digest('hex')}|${geom}`
      build = () => {
        const kind = FENCE_KINDS.find((k) => k.lang === b.lang)
        const clean = kind?.toSvg(b.body)
        return clean ? this.render(clean.svg, clean.vw, clean.vh, width, cell, card, 2) : null
      }
    } else {
      let st
      try {
        st = statSync(b.path)
      } catch {
        return null
      }
      if (!st.isFile() || st.size > MAX_PNG_BYTES) return null
      key = `i|${b.path}|${st.mtimeMs}|${st.size}|${geom}`
      build = () => {
        const dim = pngSize(b.path)
        if (!dim) return null
        const svg =
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim.w} ${dim.h}">` +
          `<image width="${dim.w}" height="${dim.h}" href="data:image/png;base64,${readFileSync(b.path).toString('base64')}"/></svg>`
        return this.render(svg, dim.w, dim.h, width, cell, card, 1)
      }
    }

    if (this.memo.has(key)) {
      const hit = this.memo.get(key)!
      if (hit) this.send(hit)
      return hit
    }
    const d = build()
    this.memo.set(key, d)
    if (d) this.send(d)
    return d
  }

  private render(svg: string, vw: number, vh: number, width: number, cell: Cell, card: string, maxScale: number): Drawn | null {
    const l: Layout = computeLayout(vw, vh, width, cell, maxScale)
    const png = rasterize({ svg, layout: l, bg: card, cacheDir: this.cacheDir })
    if (!png) return null
    const id = this.allocate()
    const lines = placeholderRows(id, l.cols, l.rows)
    if (lines.length === 0) return null
    const d: Drawn = { id, png, cols: l.cols, rows: l.rows, lines }
    this.known.set(id, d)
    return d
  }

  private allocate(): number {
    this.nextId = (this.nextId % 0xfffffe) + 1
    return this.nextId
  }

  private send(d: Drawn): void {
    if (this.sent.has(d.id)) return
    let bytes: Buffer
    try {
      bytes = readFileSync(d.png)
    } catch {
      return
    }
    this.sent.add(d.id)
    this.o.write(transmit(d.id, bytes, d.cols, d.rows, Boolean(this.env.TMUX)).join(''))
  }
}

function prevLineNonBlank(s: string, start: number): boolean {
  if (start === 0) return false
  const from = s.lastIndexOf('\n', start - 2) + 1
  return s.slice(from, start - 1).trim() !== ''
}

function nextLineNonBlank(s: string, end: number): boolean {
  if (end >= s.length) return false
  const nl = s.indexOf('\n', end + 1)
  return s.slice(end + 1, nl === -1 ? s.length : nl).trim() !== ''
}

function pngSize(path: string): { w: number; h: number } | null {
  const buf = Buffer.alloc(24)
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return null
  }
  try {
    if (readSync(fd, buf, 0, 24, 0) < 24) return null
  } finally {
    closeSync(fd)
  }
  if (buf.toString('latin1', 1, 4) !== 'PNG') return null
  const w = buf.readUInt32BE(16)
  const h = buf.readUInt32BE(20)
  return w > 0 && h > 0 && w < 30000 && h < 30000 ? { w, h } : null
}
