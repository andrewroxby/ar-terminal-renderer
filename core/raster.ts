// rsvg-convert wrapper with a sha256-keyed PNG cache in $TMPDIR/ar-term-render/.
// Failures are remembered as <key>.fail so later sessions skip them.
//
// A card is a rect drawn under the figure in a wrapper SVG, so the page stays
// transparent left of it (the indent).

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
  bg: string | null // CSS color for the card, or null for transparent
  cacheDir: string
}

export type Lookup = { state: 'hit'; path: string } | { state: 'fail' } | { state: 'miss' }

function paths(o: RasterOptions): { png: string; fail: string } {
  const l = o.layout
  const key = createHash('sha256')
    .update(JSON.stringify([o.svg, o.bg, l.pxW, l.pxH, l.fitW, l.fitH, l.left, l.top, l.cardX]))
    .digest('hex')
  const base = join(o.cacheDir, key)
  return { png: `${base}.png`, fail: `${base}.fail` }
}

// Failure markers for work that has no SVG to key them on, such as a Mermaid
// diagram that timed out. They expire like the others.
function markerPath(cacheDir: string, key: string): string {
  return join(cacheDir, `m-${createHash('sha256').update(key).digest('hex')}.fail`)
}

export function marked(cacheDir: string, key: string): boolean {
  const p = markerPath(cacheDir, key)
  try {
    if (Date.now() - statSync(p).mtimeMs <= CACHE_MAX_AGE_MS) return true
    unlinkSync(p)
  } catch {}
  return false
}

export function mark(cacheDir: string, key: string): void {
  try {
    mkdirSync(cacheDir, { recursive: true })
  } catch {}
  markFailed(markerPath(cacheDir, key))
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

function pageArgs(l: Layout): string[] {
  return [
    '-f', 'png',
    '-w', String(l.fitW),
    '-h', String(l.fitH),
    '--page-width', String(l.pxW),
    '--page-height', String(l.pxH),
    '--left', String(l.left),
    '--top', String(l.top),
  ]
}

// What goes to rsvg-convert. Without a card the figure is placed on the
// transparent page by its flags. With one, a wrapper SVG holds the card rect
// and the figure as a nested <svg> at its place, and rsvg draws the wrapper
// at page size.
function job(o: RasterOptions): { svg: string; args: string[] } {
  const l = o.layout
  if (!o.bg) return { svg: o.svg, args: pageArgs(l) }
  const fill = o.bg.replace(/[^#\w(),.% -]/g, '')
  const place = `x="${l.left}" y="${l.top}" width="${l.fitW}" height="${l.fitH}"`
  const inner = o.svg.replace(/<svg\b[^>]*>/i, (tag) =>
    tag.replace(/\s(?:x|y|width|height)\s*=\s*(?:"[^"]*"|'[^']*')/gi, '').replace(/^<svg\b/i, `<svg ${place}`),
  )
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${l.pxW}" height="${l.pxH}" viewBox="0 0 ${l.pxW} ${l.pxH}">` +
    `<rect x="${l.cardX}" y="0" width="${l.pxW - l.cardX}" height="${l.pxH}" fill="${fill}"/>${inner}</svg>`
  return { svg, args: ['-f', 'png', '-w', String(l.pxW), '-h', String(l.pxH)] }
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
  const j = job(o)
  const r = spawnSync('rsvg-convert', j.args, {
    input: j.svg,
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
    const j = job(o)
    const child = spawn('rsvg-convert', j.args, { cwd, stdio: ['pipe', 'pipe', 'ignore'] })
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
    child.stdin.end(j.svg)
  })
}
