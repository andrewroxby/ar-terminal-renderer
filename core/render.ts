// The renderer: turns figure blocks in a Markdown string into placeholder
// rows (transmitting each image once) or a text fallback. Pure apart from
// that one-time transmit and the cached PNG files. Host-neutral; the host
// supplies `write` and, optionally, a cell-size fallback and a redraw hook.

import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync } from 'node:fs'
import { DEFAULT_CARD, DEFAULT_MATH } from './color.ts'
import { defaultRun, detectGraphics, indentFromEnv, tmuxCell, type Availability, type Run } from './env.ts'
import { DEFAULT_CELL, layout as computeLayout, layoutMath, type Cell, type Layout } from './layout.ts'
import { mathToSvg } from './math.ts'
import { MermaidRunner, mermaidAvailable, refuseMermaid } from './mermaid.ts'
import { placeholderRows, transmit, transmitFile } from './kitty.ts'
import { tryLock } from './lock.ts'
import { Lru } from './lru.ts'
import { defaultCacheDir, lookup, marked, mark, render as rasterize, renderAsync, sweep, type RasterOptions } from './raster.ts'
import { scan, type Block } from './scan.ts'
import { sanitizeSvg } from './svg.ts'

export const MAX_FIGURES = 3
export const MAX_MATH = 12
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
  // Text color for display math, which is drawn without a card.
  mathColor?: () => string
  now?: () => number
  // Called when a figure rendered in the background is ready, so the host
  // can rebuild what it drew.
  onReady?: () => void
  budgetMs?: number
  mermaidTimeoutMs?: number
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
  // card: a padded, letterboxed picture on the card color.
  // math: bare text-like math, transparent, 0.8 em per cell height.
  // Both sit indent cells in from the left unless that would shrink them.
  style: 'card' | 'math'
  maxScale: number
}

// A fence kind the renderer knows. Later phases add entries here.
interface FenceKind {
  lang: string
  // Text to show when the figure is not drawn; null leaves the fence as is.
  fallback(b: Extract<Block, { kind: 'fence' }>): string | null
  // Converts on the calling thread. A kind without it converts in the
  // Mermaid worker, so the fence stays as written until the picture is ready.
  toSvg?(body: string, card: string): { svg: string; vw: number; vh: number; title: string } | null
}

const FENCE_KINDS: FenceKind[] = [
  {
    lang: 'svg',
    fallback: (b) => {
      const title = sanitizeSvg(b.body)?.title ?? ''
      return title ? `[figure: ${title}]` : '[figure]'
    },
    toSvg: (body) => sanitizeSvg(body),
  },
  { lang: 'mermaid', fallback: () => null },
]

const PENDING = Symbol('pending')

export class Renderer {
  enabled = true
  readonly cacheDir: string
  private o: Options
  private mermaid = new MermaidRunner()
  private env: NodeJS.ProcessEnv
  private run: Run
  private indent: { figure: number; math: number }
  private now: () => number
  private langs: Set<string>
  private sent = new Set<number>()
  // Figures by (png path, cols, rows). Width changes that leave the layout
  // alone land on the same entry, so they neither re-id nor re-send.
  private figures = new Lru<string, Drawn>(LRU_CAP, (_k, d) => this.sent.delete(d.id))
  private memo = new Lru<string, Drawn | null>(LRU_CAP)
  private sources = new Lru<string, Source | null>(LRU_CAP)
  private availMemo: { at: number; v: Availability } | null = null
  private cellMemo: { at: number; v: Cell } | null = null
  private nextId: number
  private spent = 0
  private queue: { key: string; run: () => Promise<boolean> }[] = []
  private queued = new Set<string>()
  private draining = false
  private idleWaiters: (() => void)[] = []
  private unsent = new Map<number, Drawn>()
  private retry: ReturnType<typeof setTimeout> | undefined

  constructor(o: Options) {
    this.o = o
    this.env = o.env ?? process.env
    this.run = o.run ?? defaultRun
    this.indent = indentFromEnv(this.env)
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
    if (!/```|~~~|!\[|\$\$|\\\[/.test(markdown)) return markdown
    const blocks = scan(markdown, this.langs)
    if (blocks.length === 0) return markdown

    this.spent = 0
    const draw = this.available().ok
    // Draw in document order so the raster budget goes to the first figures.
    let figures = 0
    let maths = 0
    const drawn = blocks.map((b) => {
      if (!draw) return null
      // A list item's indent is about what its marker takes from the width.
      const width = Math.max(4, ctx.width - b.indent.length)
      if (b.kind === 'math') return maths++ < MAX_MATH ? this.draw(b, width) : null
      return figures++ < MAX_FIGURES ? this.draw(b, width) : null
    })
    let out = markdown
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i]!
      const d = drawn[i]
      const text = d && d !== PENDING ? d.lines.join('\n') : this.fallback(b)
      if (text === null) continue
      // The block's own indentation goes on every row and on the padding, so
      // a block inside a list item stays in it. The blank lines keep the
      // rows out of a neighboring paragraph.
      const pad = b.indent
      const before = prevLineNonBlank(markdown, b.start) ? pad + '\n' : ''
      const after = nextLineNonBlank(markdown, b.end) ? '\n' + pad : ''
      out = out.slice(0, b.start) + before + indented(text, pad) + after + out.slice(b.end)
    }
    return out
  }

  // True while figures are still rendering in the background.
  pending(): boolean {
    return this.draining || this.queue.length > 0
  }

  // Resolves once the background renders queued so far are done. A host that
  // can exit before they land holds the process open until then.
  idle(): Promise<void> {
    if (!this.pending()) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
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
    this.sources.clear()
    this.unsent.clear()
    this.queue = []
    this.queued.clear()
    this.mermaid.close()
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

  // What replaces a block that is not drawn. null leaves the original
  // text in place, for Pi's own math and Mermaid renderers.
  private fallback(b: Block): string | null {
    if (b.kind === 'math') return null
    if (b.kind === 'image') return b.alt ? `[image: ${b.alt} - ${b.path}]` : `[image: ${b.path}]`
    return FENCE_KINDS.find((k) => k.lang === b.lang)?.fallback(b) ?? null
  }

  private draw(b: Block, width: number): Drawn | null | typeof PENDING {
    const cell = this.cell()
    const card = this.o.card?.() ?? DEFAULT_CARD
    const mathColor = this.o.mathColor?.() ?? DEFAULT_MATH
    const indent = b.kind === 'math' ? this.indent.math : this.indent.figure
    const geom = `${width}|${cell.w}x${cell.h}|${indent}|${card}|${mathColor}`

    let key: string
    let expensive = false
    let make: () => Source | null = () => null
    // Set for kinds that convert in the Mermaid worker.
    let makeAsync: (() => Promise<Source | null | undefined>) | null = null
    let skey: string | null = null
    if (b.kind === 'fence' || b.kind === 'math') {
      const kind = b.kind === 'fence' ? FENCE_KINDS.find((k) => k.lang === b.lang) : undefined
      if (b.kind === 'fence' && !kind) return null
      const digest = createHash('sha256').update((b.kind === 'fence' ? b.lang : '$$') + '\0' + b.body).digest('hex')
      expensive = b.kind === 'math'
      skey = `${b.kind === 'fence' ? b.lang : 'math'}|${digest}|${card}|${mathColor}`
      key = `${skey}|${width}|${cell.w}x${cell.h}|${indent}`
      if (b.kind === 'math') {
        make = () => {
          const m = mathToSvg(b.body, mathColor)
          return m ? { svg: m.svg, vw: m.vw, vh: m.vh, style: 'math', maxScale: 1 } : null
        }
      } else if (kind!.toSvg) {
        make = () => {
          const clean = kind!.toSvg!(b.body, card)
          return clean ? { svg: clean.svg, vw: clean.vw, vh: clean.vh, style: 'card', maxScale: 2 } : null
        }
      } else {
        // Refusals are decided at once and remembered, in memory and on disk.
        if (this.sources.get(skey) === undefined && (refuseMermaid(b.body) || !mermaidAvailable() || marked(this.cacheDir, skey))) {
          this.sources.set(skey, null)
        }
        makeAsync = async () => {
          const r = await this.mermaid.run(b.body, card, this.o.mermaidTimeoutMs)
          if (r.state === 'closed') return undefined
          if (r.state === 'bad' || r.state === 'timeout') mark(this.cacheDir, skey!)
          if (r.state !== 'ok') return null
          return { svg: r.svg.svg, vw: r.svg.vw, vh: r.svg.vh, style: 'card', maxScale: 2 }
        }
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
        make = () =>
          dim && data
            ? {
                svg:
                  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim.w} ${dim.h}">` +
                  `<image width="${dim.w}" height="${dim.h}" href="data:image/png;base64,${data.toString('base64')}"/></svg>`,
                vw: dim.w,
                vh: dim.h,
                style: 'card',
                maxScale: 1,
              }
            : null
      } finally {
        closeSync(fd)
      }
    }

    if (this.memo.has(key)) return this.fromMemo(key)

    const finish = (src: Source): RasterOptions => {
      const layout: Layout =
        src.style === 'math'
          ? layoutMath(src.vw, src.vh, width, cell, indent)
          : computeLayout(src.vw, src.vh, width, cell, src.maxScale, indent)
      return { svg: src.svg, layout, bg: src.style === 'math' ? null : card, cacheDir: this.cacheDir }
    }

    let src = skey ? this.sources.get(skey) : undefined
    if (src === undefined) {
      if (makeAsync) {
        const convert = makeAsync
        // The fence stays as written until the picture is ready.
        this.enqueue(key, async () => {
          let made = this.sources.get(skey!)
          if (made === undefined) {
            made = await convert()
            if (made !== undefined) this.sources.set(skey!, made)
          }
          return made ? (await renderAsync(finish(made))) !== null : false
        })
        return PENDING
      }
      if (expensive && this.spent >= this.budget()) {
        // Convert and rasterize later, off the render path.
        this.enqueue(key, async () => {
          const made = make()
          if (skey) this.sources.set(skey, made)
          return made ? (await renderAsync(finish(made))) !== null : false
        })
        return PENDING
      }
      const t0 = this.now()
      src = make()
      this.spent += this.now() - t0
      if (skey) this.sources.set(skey, src)
    }
    if (!src) {
      this.memo.set(key, null)
      return null
    }
    const ro = finish(src)

    let hit = lookup(ro)
    if (hit.state === 'miss') {
      if (this.spent >= this.budget()) {
        this.enqueue(key, async () => (await renderAsync(ro)) !== null)
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

  private budget(): number {
    return this.o.budgetMs ?? RASTER_BUDGET_MS
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
  private enqueue(key: string, run: () => Promise<boolean>): void {
    if (this.queued.has(key)) return
    this.queued.add(key)
    this.queue.push({ key, run })
    if (!this.draining) {
      this.draining = true
      setTimeout(() => void this.drain(), 0).unref()
    }
  }

  private async drain(): Promise<void> {
    let ready = false
    for (let item = this.queue.shift(); item; item = this.queue.shift()) {
      try {
        if (await item.run()) ready = true
      } catch {}
      this.queued.delete(item.key)
    }
    this.draining = false
    for (const w of this.idleWaiters.splice(0)) w()
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

const indented = (text: string, pad: string): string => (pad ? text.split('\n').map((l) => pad + l).join('\n') : text)

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
