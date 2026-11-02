// rsvg-convert wrapper with a sha256-keyed PNG cache in $TMPDIR/ar-term-render/.
// Failures are remembered as <key>.fail so later sessions skip them.

import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, constants, mkdirSync, openSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Layout } from './layout.ts'

export const CACHE_MAX_AGE_MS = 7 * 24 * 3600 * 1000
export const RSVG_TIMEOUT_MS = 1500
const MAX_OUT = 64 * 1024 * 1024

export function defaultCacheDir(): string {
  return join(process.env.TMPDIR || tmpdir(), 'ar-term-render')
}

// Deletes cached PNGs, failure markers and stray temp files older than
// maxAge. Returns how many went.
export function sweep(dir: string, maxAgeMs = CACHE_MAX_AGE_MS, now = Date.now()): number {
  let n = 0
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  for (const name of names) {
    if (!/\.(png|fail|tmp)$/.test(name)) continue
    const p = join(dir, name)
    try {
      if (now - statSync(p).mtimeMs > maxAgeMs) {
        unlinkSync(p)
        n++
      }
    } catch {}
  }
  return n
}

export interface RasterOptions {
  svg: string
  layout: Layout
  bg: string // CSS color for the card
  cacheDir: string
}

export type Lookup = { state: 'hit'; path: string } | { state: 'fail' } | { state: 'miss' }

function paths(o: RasterOptions): { png: string; fail: string } {
  const l = o.layout
  const key = createHash('sha256')
    .update(JSON.stringify([o.svg, o.bg, l.pxW, l.pxH, l.fitW, l.fitH, l.left, l.top]))
    .digest('hex')
  const base = join(o.cacheDir, key)
  return { png: `${base}.png`, fail: `${base}.fail` }
}

// Cache check only: never spawns.
export function lookup(o: RasterOptions): Lookup {
  const p = paths(o)
  try {
    statSync(p.png)
    const now = new Date()
    utimesSync(p.png, now, now)
    return { state: 'hit', path: p.png }
  } catch {}
  try {
    if (Date.now() - statSync(p.fail).mtimeMs <= CACHE_MAX_AGE_MS) return { state: 'fail' }
    unlinkSync(p.fail)
  } catch {}
  return { state: 'miss' }
}

function args(l: Layout, bg: string): string[] {
  return [
    '-f', 'png',
    '-w', String(l.fitW),
    '-h', String(l.fitH),
    '--page-width', String(l.pxW),
    '--page-height', String(l.pxH),
    '--left', String(l.left),
    '--top', String(l.top),
    '-b', bg,
  ]
}

// rsvg runs in an empty directory of its own with the SVG on stdin, so a
// stray relative reference finds nothing.
function emptyCwd(cacheDir: string): string | null {
  const cwd = join(cacheDir, 'cwd')
  try {
    mkdirSync(cwd, { recursive: true })
    return cwd
  } catch {
    return null
  }
}

// Writes through an exclusive, randomly named temp file and renames it in.
function store(dest: string, data: Buffer): boolean {
  const tmp = `${dest}.${randomBytes(6).toString('hex')}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    writeSync(fd, data)
    closeSync(fd)
    fd = undefined
    renameSync(tmp, dest)
    return true
  } catch {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {}
    }
    try {
      unlinkSync(tmp)
    } catch {}
    return false
  }
}

function markFailed(failPath: string): void {
  store(failPath, Buffer.alloc(0))
}

// A missing rsvg-convert is not a property of the figure, so it is never
// remembered as a failure.
function finish(p: { png: string; fail: string }, out: Buffer | null, remember: boolean): string | null {
  if (out && out.length >= 8 && store(p.png, out)) return p.png
  if (remember) markFailed(p.fail)
  return null
}

// Synchronous render; blocks for at most RSVG_TIMEOUT_MS.
export function render(o: RasterOptions): string | null {
  const p = paths(o)
  const cwd = emptyCwd(o.cacheDir)
  if (!cwd) return null
  const r = spawnSync('rsvg-convert', args(o.layout, o.bg), {
    input: o.svg,
    cwd,
    timeout: RSVG_TIMEOUT_MS,
    maxBuffer: MAX_OUT,
  })
  const missing = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
  const ok = r.status === 0 && Buffer.isBuffer(r.stdout)
  return finish(p, ok ? (r.stdout as Buffer) : null, !missing)
}

// Same render without blocking the event loop.
export function renderAsync(o: RasterOptions): Promise<string | null> {
  const p = paths(o)
  const cwd = emptyCwd(o.cacheDir)
  if (!cwd) return Promise.resolve(null)
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let missing = false
    let settled = false
    const child = spawn('rsvg-convert', args(o.layout, o.bg), { cwd, stdio: ['pipe', 'pipe', 'ignore'] })
    const done = (out: Buffer | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(finish(p, out, !missing))
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      done(null)
    }, RSVG_TIMEOUT_MS)
    child.on('error', (e) => {
      missing = (e as NodeJS.ErrnoException).code === 'ENOENT'
      done(null)
    })
    child.stdout.on('data', (d: Buffer) => {
      size += d.length
      if (size > MAX_OUT) child.kill('SIGKILL')
      else chunks.push(d)
    })
    child.stdin.on('error', () => {})
    child.on('close', (code) => done(code === 0 ? Buffer.concat(chunks) : null))
    child.stdin.end(o.svg)
  })
}
