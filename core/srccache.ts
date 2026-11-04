// Disk cache of converted SVG sources (TeX through MathJax, Mermaid through
// its layout worker), keyed on what went into the conversion. A process that
// meets a formula an earlier process drew skips the conversion, and MathJax
// is never loaded for it. The PNG cache cannot do that alone: its key is the
// SVG text, which only the conversion produces.
//
// Entries are JSON files named s-<key>.json in the PNG cache directory, aged
// out with it. Bump SRC_VERSION when a converter, sanitizer or the SVG it
// writes changes in a way the inputs do not show.

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { store } from './raster.ts'
import type { CleanSvg } from './svg.ts'

const SRC_VERSION = 1

// A bundle rebuilt in place (npm run build) changes size or mtime, so entries
// made from the old one stop matching.
const stamps = new Map<string, string>()

export function bundleStamp(path: string): string {
  let s = stamps.get(path)
  if (s === undefined) {
    try {
      const st = statSync(path)
      s = `${st.size}:${Math.floor(st.mtimeMs)}`
    } catch {
      s = 'none'
    }
    stamps.set(path, s)
  }
  return s
}

export function srcKey(...parts: (string | number | boolean)[]): string {
  return createHash('sha256').update(JSON.stringify([SRC_VERSION, ...parts])).digest('hex')
}

function srcPath(cacheDir: string, key: string): string {
  return join(cacheDir, `s-${key}.json`)
}

// The cached conversion, or null. A hit is touched so it ages with its PNGs.
export function srcGet(cacheDir: string, key: string): CleanSvg | null {
  const p = srcPath(cacheDir, key)
  try {
    const v = JSON.parse(readFileSync(p, 'utf8')) as Partial<CleanSvg>
    if (typeof v.svg !== 'string' || typeof v.vw !== 'number' || typeof v.vh !== 'number' || typeof v.title !== 'string') return null
    const now = new Date()
    utimesSync(p, now, now)
    return { svg: v.svg, vw: v.vw, vh: v.vh, title: v.title }
  } catch {
    return null
  }
}

export function srcPut(cacheDir: string, key: string, v: CleanSvg): void {
  try {
    mkdirSync(cacheDir, { recursive: true })
  } catch {}
  store(srcPath(cacheDir, key), Buffer.from(JSON.stringify(v)))
}
