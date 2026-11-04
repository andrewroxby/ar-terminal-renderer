// `ar-term-render serve`: one long-lived process that answers `tex` requests,
// so an editor pays node's start and MathJax's load once instead of once per
// formula. Newline-delimited JSON, one request per line in, one answer per
// line out, in whatever order the renders finish:
//
//   {"id": 1, "tex": "x^2", "display": true, "color": "#d4d4d4", "emPx": 64, "cell": "9x20"}
//   {"id": 1, "path": "/tmp/ar-term-render/<key>.png"}
//   {"id": 2, "error": "could not typeset that LaTeX", "rejected": true}
//
// Fields other than id and tex are the `tex` command's options (display,
// color, background, emPx, cell, scale, padding). `rejected` means the input
// itself was refused; without it the run failed and may pass another time.
// It exits when its input closes, or after IDLE_MS with nothing asked.

import type { Readable, Writable } from 'node:stream'
import { createInterface } from 'node:readline'
import { lookup, renderAsync, sweepDaily } from './raster.ts'
import { Fail, texCanvas, type TexArgs } from './tex.ts'

export const IDLE_MS = 10 * 60 * 1000
const MAX_PARALLEL = 4

export interface ServeOptions {
  cacheDir: string
  idleMs?: number
}

interface Request extends Partial<TexArgs> {
  id?: unknown
  op?: unknown
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function numeric(name: string, v: unknown): number | undefined {
  if (v === undefined) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Fail(`${name} must be a non-negative number`, 2, true)
  return v
}

export async function serve(input: Readable, output: Writable, o: ServeOptions): Promise<void> {
  const idleMs = o.idleMs ?? IDLE_MS
  sweepDaily(o.cacheDir)

  let inflight = 0
  let running = 0
  const waiting: (() => void)[] = []
  let closed = false
  let idle: ReturnType<typeof setTimeout> | undefined
  let finish!: () => void
  const done = new Promise<void>((resolve) => (finish = resolve))

  const check = (): void => {
    if (idle) clearTimeout(idle)
    idle = undefined
    if (closed && inflight === 0) return finish()
    if (inflight === 0) {
      idle = setTimeout(() => {
        closed = true
        rl.close()
        finish()
      }, idleMs)
      idle.unref()
    }
  }

  // At most MAX_PARALLEL rsvg processes at a time, whatever the client sends.
  const slot = async <T>(fn: () => Promise<T>): Promise<T> => {
    while (running >= MAX_PARALLEL) await new Promise<void>((r) => waiting.push(r))
    running++
    try {
      return await fn()
    } finally {
      running--
      waiting.shift()?.()
    }
  }

  const answer = (id: unknown, body: object): void => {
    output.write(JSON.stringify({ id, ...body }) + '\n')
  }

  const handle = async (line: string): Promise<void> => {
    let id: unknown
    try {
      const req = JSON.parse(line) as Request
      id = req.id
      if (req.op !== undefined && req.op !== 'tex') throw new Fail(`unknown op ${String(req.op)}`, 2, true)
      const args: TexArgs = {
        tex: str(req.tex) ?? '',
        display: typeof req.display === 'boolean' ? req.display : undefined,
        color: str(req.color),
        background: str(req.background),
        cell: str(req.cell),
        emPx: numeric('emPx', req.emPx),
        scale: numeric('scale', req.scale),
        padding: numeric('padding', req.padding),
      }
      const canvas = texCanvas(args, o.cacheDir)
      const hit = lookup(canvas)
      const path = hit.state === 'hit' ? hit.path : hit.state === 'miss' ? await slot(() => renderAsync(canvas)) : null
      if (path) answer(id, { path })
      else answer(id, { error: 'rendering failed (is rsvg-convert installed?)', rejected: false })
    } catch (e) {
      const rejected = e instanceof Fail ? e.rejected : e instanceof SyntaxError
      answer(id, { error: (e as Error).message, rejected })
    }
  }

  const rl = createInterface({ input })
  rl.on('line', (line) => {
    if (!line.trim()) return
    inflight++
    if (idle) clearTimeout(idle)
    void handle(line).finally(() => {
      inflight--
      check()
    })
  })
  rl.on('close', () => {
    closed = true
    check()
  })
  check()
  await done
  await new Promise<void>((resolve) => output.write('', () => resolve()))
}
