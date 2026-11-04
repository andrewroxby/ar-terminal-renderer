// Mermaid to SVG through beautiful-mermaid, on the dark card. The layout
// engine is synchronous and has no upper bound on dense graphs, so it runs
// in a worker thread that is terminated after MERMAID_TIMEOUT_MS. Nothing
// here ever runs it on the calling thread.
//
// Anything it cannot parse (unsupported diagram types, syntax errors) comes
// back as 'bad', so Pi's own Unicode Mermaid draws the fence.

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { flattenCssVars } from './cssvars.ts'
import { bundleStamp } from './srccache.ts'
import { MAX_CONVERTED_BYTES, sanitizeSvg, type CleanSvg } from './svg.ts'

export const MERMAID_TIMEOUT_MS = 2000
const MAX_SOURCE = 20_000
const MAX_EDGES = 300
const MAX_NODES = 150
const WORKER_FILE = fileURLToPath(new URL('./vendor/mermaid-worker.cjs', import.meta.url))

// bad: refused or unparseable, and will stay so. timeout: gave up after the
// deadline. missing and closed say nothing about the diagram.
type MermaidResult =
  | { state: 'ok'; svg: CleanSvg }
  | { state: 'bad' }
  | { state: 'timeout' }
  | { state: 'missing' }
  | { state: 'closed' }

// Changes when the bundled layout code is rebuilt, for keys that depend on it.
export function mermaidStamp(): string {
  return bundleStamp(WORKER_FILE)
}

export function mermaidAvailable(): boolean {
  return existsSync(WORKER_FILE)
}

// Cheap checks on the source text, before any worker is involved. Layout
// time grows with edges, and one `a0 & a1 & ... --> b0 & b1 & ...` line
// expands to a product of edges, so this counts what the `&` chains expand
// to in flowcharts. Returns a reason to refuse, or null.
export function refuseMermaid(source: string): string | null {
  if (!source.trim()) return 'empty'
  if (source.length > MAX_SOURCE) return 'too long'
  if (!/^\s*(?:%%[^\n]*\n\s*)*(?:graph|flowchart)\b/.test(source)) return null

  // Labels and shapes can hold arrows and ampersands.
  const plain = source
    .replace(/"[^"\n]*"/g, '')
    .replace(/\[[^\]\n]*\]|\([^)\n]*\)|\{[^}\n]*\}/g, '')
  const arrow = /<?(?:-{2,}|={2,}|-\.+-)[>xo-]?(?:\|[^|\n]*\|)?/
  const ids = new Set<string>()
  let edges = 0
  for (const line of plain.split(/[\n;]/)) {
    if (/^\s*(?:graph|flowchart|subgraph|end|direction|style|classDef|class|linkStyle|click)\b/.test(line)) continue
    const chain = line.split(arrow).map((seg) => seg.split('&').map((n) => n.trim()).filter(Boolean))
    for (const group of chain) for (const n of group) ids.add(/^[\w.-]*/.exec(n)![0])
    for (let i = 1; i < chain.length; i++) edges += chain[i - 1]!.length * chain[i]!.length
    if (edges > MAX_EDGES) return 'too many edges'
  }
  if (ids.size > MAX_NODES) return 'too many nodes'
  return null
}

// Converts diagrams one at a time on a single lazily created worker.
// The worker is unref'd and replaced after a timeout; close() ends it.
export class MermaidRunner {
  private worker: Worker | undefined
  private job: ((r: { svg: string | null; closed?: boolean }) => void) | undefined
  private tail: Promise<unknown> = Promise.resolve()
  private generation = 0

  run(source: string, card: string, timeoutMs = MERMAID_TIMEOUT_MS): Promise<MermaidResult> {
    const gen = this.generation
    const result = this.tail.then(() => (gen === this.generation ? this.exec(source, card, timeoutMs) : { state: 'closed' as const }))
    this.tail = result.catch(() => {})
    return result
  }

  // Ends the worker now. A job in flight resolves 'closed'; the runner
  // starts a fresh worker for the next run.
  close(): void {
    this.generation++
    this.stop()
  }

  private stop(): void {
    const w = this.worker
    this.worker = undefined
    this.job?.({ svg: null, closed: true })
    this.job = undefined
    w?.terminate().catch(() => {})
  }

  private ensure(): Worker | undefined {
    if (this.worker) return this.worker
    if (!mermaidAvailable()) return undefined
    let w: Worker
    try {
      w = new Worker(WORKER_FILE, { resourceLimits: { maxOldGenerationSizeMb: 384 } })
    } catch {
      return undefined
    }
    w.on('message', (m: { svg: string | null }) => {
      if (this.worker === w) this.job?.(m)
    })
    // An out-of-memory or crash ends the job as a failure.
    const died = (): void => {
      if (this.worker !== w) return
      this.worker = undefined
      this.job?.({ svg: null })
    }
    w.on('error', died)
    w.on('exit', died)
    // After the listeners: adding a 'message' listener takes a reference.
    w.unref()
    this.worker = w
    return w
  }

  private exec(source: string, card: string, timeoutMs: number): Promise<MermaidResult> {
    if (refuseMermaid(source)) return Promise.resolve({ state: 'bad' })
    const w = this.ensure()
    if (!w) return Promise.resolve({ state: 'missing' })
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.worker = undefined
        this.job = undefined
        w.terminate().catch(() => {})
        resolve({ state: 'timeout' })
      }, timeoutMs)
      timer.unref()
      this.job = (r) => {
        clearTimeout(timer)
        this.job = undefined
        if (r.closed) return resolve({ state: 'closed' })
        resolve(r.svg ? convert(r.svg) : { state: 'bad' })
      }
      w.postMessage({ source, card })
    })
  }
}

function convert(raw: string): MermaidResult {
  if (!raw.includes('<svg') || raw.length > MAX_CONVERTED_BYTES) return { state: 'bad' }
  // The default font is not installed; the generic family always resolves.
  const flat = flattenCssVars(raw).replace(/font-family:[^;}]*/g, 'font-family: sans-serif')
  const svg = sanitizeSvg(flat, MAX_CONVERTED_BYTES)
  return svg ? { state: 'ok', svg } : { state: 'bad' }
}
