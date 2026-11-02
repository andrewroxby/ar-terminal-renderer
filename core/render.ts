// The renderer: turns figure blocks in a Markdown string into placeholder
// rows (transmitting each image once) or a text fallback. Pure apart from
// that one-time transmit and the cached PNG files. Host-neutral; the host
// supplies `write` and, optionally, a cell-size fallback and a redraw hook.

import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync } from 'node:fs'
import { DEFAULT_CARD } from './color.ts'
import { defaultRun, detectGraphics, tmuxCell, type Availability, type Run } from './env.ts'
import { DEFAULT_CELL, layout as computeLayout, type Cell } from './layout.ts'
import { placeholderRows, transmit, transmitFile } from './kitty.ts'
import { tryLock } from './lock.ts'
import { Lru } from './lru.ts'
import { defaultCacheDir, lookup, render as rasterize, renderAsync, sweep, type RasterOptions } from './raster.ts'
import { scan, type Block } from './scan.ts'
import { sanitizeSvg } from './svg.ts'

export const MAX_FIGURES = 3
export const MAX_PNG_BYTES = 10 * 1024 * 1024
export const MAX_PNG_PIXELS = 16_000_000
export const RASTER_BUDGET_MS = 300
const MEMO_TTL_MS = 2000
const MAX_RESEND = 30
const LRU_CAP = 128

export interface Options {
  write: (data: string) => void
  env?: NodeJS.ProcessEnv
  run?: Run
  cacheDir?: string
  cellFallback?: () => Cell | undefined
  card?: () => string
  now?: () => number
  // Called when a figure rendered in the background is ready, so the host
  // can rebuild what it drew.
  onReady?: () => void
  budgetMs?: number
  lockWaitMs?: number
  retryMs?: number
}

interface Drawn {
  id: number
  png: string
  cols: number
  rows: number
  lines: string[]
}

interface Source {
  svg: string
  vw: number
  vh: number
  maxScale: number
}

// A fence kind the renderer knows. Later phases (math, mermaid) add entries.
interface FenceKind {
  lang: string
  toSvg(body: string): { svg: string; vw: number; vh: number; title: string } | null
}

const FENCE_KINDS: FenceKind[] = [{ lang: 'svg', toSvg: sanitizeSvg }]

const PENDING = Symbol('pending')

export class Renderer {
  enabled = true
  readonly cacheDir: string
  private o: Options
  private env: NodeJS.ProcessEnv
  private run: Run
  private now: () => number
  private langs: Set<string>
  private sent = new Set<number>()
  // Figures by (png path, cols, rows). Width changes that leave the layout
  // alone land on the same entry, so they neither re-id nor re-send.
  private figures = new Lru<string, Drawn>(LRU_CAP, (_k, d) => this.sent.delete(d.id))
  private memo = new Lru<string, Drawn | null>(LRU_CAP)
  private availMemo: { at: number; v: Availability } | null = null
  private cellMemo: { at: number; v: Cell } | null = null
  private nextId: number
  private spent = 0
  private queue: { key: string; o: RasterOptions }[] = []
  private queued = new Set<string>()
  private draining = false
  private unsent = new Map<number, Drawn>()
  private retry: ReturnType<typeof setTimeout> | undefined

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

    this.spent = 0
    const draw = this.available().ok
    // Draw in document order so the raster budget goes to the first figures.
    const drawn = blocks.map((b, i) => (draw && i < MAX_FIGURES ? this.draw(b, ctx.width) : null))
    let out = markdown
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i]!
      const d = drawn[i]
      const text = d && d !== PENDING ? d.lines.join('\n') : this.fallback(b)
      // Blank lines keep the rows out of a neighboring paragraph.
      const before = prevLineNonBlank(markdown, b.start) ? '\n' : ''
      const after = nextLineNonBlank(markdown, b.end) ? '\n' : ''
      out = out.slice(0, b.start) + before + text + after + out.slice(b.end)
    }
    return out
  }

  // Sends the most recently used images again, for a client that attached
  // late or a terminal that lost its store. Returns how many were sent.
  redraw(): number {
    this.sent.clear()
    this.availMemo = null
    this.cellMemo = null
    const recent = this.figures.values().slice(-MAX_RESEND)
    for (const d of recent) this.send(d)
    return recent.length
  }

  // Drops everything remembered about the session's figures.
  forget(): void {
    this.sent.clear()
    this.figures.clear()
    this.memo.clear()
    this.unsent.clear()
    this.queue = []
    this.queued.clear()
    if (this.retry) clearTimeout(this.retry)
    this.retry = undefined
  }

  status(): { enabled: boolean; available: Availability; cell: Cell; images: number; cacheDir: string } {
    return {
      enabled: this.enabled,
      available: this.available(),
      cell: this.cell(),
      images: this.figures.size,
      cacheDir: this.cacheDir,
    }
  }

  private fallback(b: Block): string {
    if (b.kind === 'image') return b.alt ? `[image: ${b.alt} - ${b.path}]` : `[image: ${b.path}]`
    const kind = FENCE_KINDS.find((k) => k.lang === b.lang)
    const title = kind?.toSvg(b.body)?.title ?? ''
    return title ? `[figure: ${title}]` : '[figure]'
  }

  private draw(b: Block, width: number): Drawn | null | typeof PENDING {
    const cell = this.cell()
    const card = this.o.card?.() ?? DEFAULT_CARD
    const geom = `${width}|${cell.w}x${cell.h}|${card}`

    let key: string
    let source: () => Source | null
    if (b.kind === 'fence') {
      key = `f|${createHash('sha256').update(b.lang + '\0' + b.body).digest('hex')}|${geom}`
      source = () => {
        const clean = FENCE_KINDS.find((k) => k.lang === b.lang)?.toSvg(b.body)
        return clean ? { svg: clean.svg, vw: clean.vw, vh: clean.vh, maxScale: 2 } : null
      }
    } else {
      // Open first and ask the descriptor, so the checks and the read see
      // the same file, and a fifo or device is refused without blocking.
      let fd: number
      try {
        fd = openSync(b.path, constants.O_RDONLY | constants.O_NONBLOCK)
      } catch {
        return null
      }
      try {
        const st = fstatSync(fd)
        if (!st.isFile() || st.size > MAX_PNG_BYTES) return null
        key = `i|${b.path}|${st.mtimeMs}|${st.size}|${geom}`
        if (this.memo.has(key)) return this.fromMemo(key)
        const dim = pngSize(fd)
        const data = dim ? readFileSync(fd) : null
        source = () =>
          dim && data
            ? {
                svg:
                  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim.w} ${dim.h}">` +
                  `<image width="${dim.w}" height="${dim.h}" href="data:image/png;base64,${data.toString('base64')}"/></svg>`,
                vw: dim.w,
                vh: dim.h,
                maxScale: 1,
              }
            : null
      } finally {
        closeSync(fd)
      }
    }

    if (this.memo.has(key)) return this.fromMemo(key)
    const src = source()
    if (!src) {
      this.memo.set(key, null)
      return null
    }
    const ro: RasterOptions = {
      svg: src.svg,
      layout: computeLayout(src.vw, src.vh, width, cell, src.maxScale),
      bg: card,
      cacheDir: this.cacheDir,
    }

    let hit = lookup(ro)
    if (hit.state === 'miss') {
      if (this.spent >= (this.o.budgetMs ?? RASTER_BUDGET_MS)) {
        this.enqueue(key, ro)
        return PENDING
      }
      const t0 = this.now()
      const path = rasterize(ro)
      this.spent += this.now() - t0
      hit = path ? { state: 'hit', path } : { state: 'fail' }
    }
    if (hit.state === 'fail') {
      this.memo.set(key, null)
      return null
    }
    const d = this.figure(hit.path, ro.layout.cols, ro.layout.rows)
    if (!d) {
      this.memo.set(key, null)
      return null
    }
    this.memo.set(key, d)
    this.send(d)
    return d
  }

  private fromMemo(key: string): Drawn | null {
    const hit = this.memo.get(key)!
    if (hit) {
      this.figures.set(figKey(hit.png, hit.cols, hit.rows), hit)
      this.send(hit)
    }
    return hit
  }

  private figure(png: string, cols: number, rows: number): Drawn | null {
    const k = figKey(png, cols, rows)
    const have = this.figures.get(k)
    if (have) return have
    const id = this.allocate()
    const lines = placeholderRows(id, cols, rows)
    if (lines.length === 0) return null
    const d: Drawn = { id, png, cols, rows, lines }
    this.figures.set(k, d)
    return d
  }

  private allocate(): number {
    this.nextId = (this.nextId % 0xfffffe) + 1
    return this.nextId
  }

  // Figures past the per-render raster budget render later, one at a time,
  // off the event loop. onReady lets the host rebuild what it drew.
  private enqueue(key: string, o: RasterOptions): void {
    if (this.queued.has(key)) return
    this.queued.add(key)
    this.queue.push({ key, o })
    if (!this.draining) {
      this.draining = true
      setTimeout(() => void this.drain(), 0).unref()
    }
  }

  private async drain(): Promise<void> {
    let ready = false
    for (let item = this.queue.shift(); item; item = this.queue.shift()) {
      const path = await renderAsync(item.o)
      this.queued.delete(item.key)
      if (path) ready = true
    }
    this.draining = false
    if (ready) this.o.onReady?.()
  }

  private send(d: Drawn): void {
    if (this.sent.has(d.id)) return
    const tmux = Boolean(this.env.TMUX)
    if (this.available().mode === 'file') {
      this.sent.add(d.id)
      this.o.write(transmitFile(d.id, d.png, d.cols, d.rows, tmux))
      return
    }
    let bytes: Buffer
    try {
      bytes = readFileSync(d.png)
    } catch {
      return
    }
    // Chunks carry no id, so a whole image goes out under a cross-process
    // lock. When it is busy the image waits for a short timer.
    const release = tryLock(this.cacheDir, this.o.lockWaitMs ?? 200)
    if (!release) {
      this.unsent.set(d.id, d)
      if (!this.retry) {
        this.retry = setTimeout(() => {
          this.retry = undefined
          const waiting = [...this.unsent.values()]
          this.unsent.clear()
          for (const w of waiting) this.send(w)
        }, (this.o.retryMs ?? 100) + Math.random() * 150)
        this.retry.unref()
      }
      return
    }
    try {
      this.sent.add(d.id)
      this.unsent.delete(d.id)
      this.o.write(transmit(d.id, bytes, d.cols, d.rows, tmux).join(''))
    } finally {
      release()
    }
  }
}

const figKey = (png: string, cols: number, rows: number): string => `${png}|${cols}x${rows}`

function nextLineNonBlank(s: string, end: number): boolean {
  if (end >= s.length) return false
  const nl = s.indexOf('\n', end + 1)
  return s.slice(end + 1, nl === -1 ? s.length : nl).trim() !== ''
}

function prevLineNonBlank(s: string, start: number): boolean {
  if (start === 0) return false
  const from = s.lastIndexOf('\n', start - 2) + 1
  return s.slice(from, start - 1).trim() !== ''
}

// Width and height from the IHDR of an open file. Refuses signatures that
// are not PNG and images that would decode to more than MAX_PNG_PIXELS.
function pngSize(fd: number): { w: number; h: number } | null {
  const buf = Buffer.alloc(24)
  if (readSync(fd, buf, 0, 24, 0) < 24) return null
  if (buf.toString('latin1', 1, 4) !== 'PNG') return null
  const w = buf.readUInt32BE(16)
  const h = buf.readUInt32BE(20)
  return w > 0 && h > 0 && w * h <= MAX_PNG_PIXELS ? { w, h } : null
}
