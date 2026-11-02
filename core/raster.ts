// rsvg-convert wrapper with a sha256-keyed PNG cache in $TMPDIR/ar-term-render/.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Layout } from './layout.ts'

export const CACHE_MAX_AGE_MS = 7 * 24 * 3600 * 1000
export const RSVG_TIMEOUT_MS = 5000

export function defaultCacheDir(): string {
  return join(process.env.TMPDIR || tmpdir(), 'ar-term-render')
}

// Deletes cached PNGs older than maxAge. Returns how many went.
export function sweep(dir: string, maxAgeMs = CACHE_MAX_AGE_MS, now = Date.now()): number {
  let n = 0
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  for (const name of names) {
    if (!name.endsWith('.png') && !name.endsWith('.tmp')) continue
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

// Returns the path of the cached PNG, rendering it when absent, or null.
export function rasterize(o: RasterOptions): string | null {
  const l = o.layout
  const key = createHash('sha256')
    .update(JSON.stringify([o.svg, o.bg, l.pxW, l.pxH, l.fitW, l.fitH, l.left, l.top]))
    .digest('hex')
  const path = join(o.cacheDir, `${key}.png`)
  try {
    statSync(path)
    const now = new Date()
    utimesSync(path, now, now)
    return path
  } catch {}

  // rsvg runs in an empty directory of its own, with the SVG on stdin, so a
  // stray relative reference finds nothing.
  const cwd = join(o.cacheDir, 'cwd')
  try {
    mkdirSync(cwd, { recursive: true })
  } catch {
    return null
  }
  const r = spawnSync(
    'rsvg-convert',
    [
      '-f', 'png',
      '-w', String(l.fitW),
      '-h', String(l.fitH),
      '--page-width', String(l.pxW),
      '--page-height', String(l.pxH),
      '--left', String(l.left),
      '--top', String(l.top),
      '-b', o.bg,
    ],
    { input: o.svg, cwd, timeout: RSVG_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
  )
  if (r.status !== 0 || !Buffer.isBuffer(r.stdout) || r.stdout.length < 8) return null

  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, r.stdout)
    renameSync(tmp, path)
  } catch {
    try {
      unlinkSync(tmp)
    } catch {}
    return null
  }
  return path
}
