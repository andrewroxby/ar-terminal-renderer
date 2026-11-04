// Disk cache of converted SVG sources (TeX through MathJax, Mermaid through
// its layout worker), keyed on what went into the conversion. A process that
// meets a formula an earlier process drew skips the conversion, and MathJax
// is never loaded for it. The PNG cache cannot do that alone: its key is the
// SVG text, which only the conversion produces.
//
// Entries are JSON files named s-<key>.json in the PNG cache directory, aged
// out with it. Keys cover the inputs, the vendor bundles' stamps, and the
// text of the source files that shape a conversion's output, so editing any
// of them retires old entries by itself. A hit is sanitized again on read,
// so the cache directory is not trusted.

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { store } from './raster.ts'
import { MAX_CONVERTED_BYTES, sanitizeSvg, type CleanSvg } from './svg.ts'

// Sources whose behavior decides what a conversion writes.
const CODE_FILES = ['math.ts', 'svg.ts', 'cssvars.ts', 'mermaid.ts', 'srccache.ts']

let codeStamp: string | undefined

// A hash of CODE_FILES, read once per process.
function code(): string {
  if (codeStamp === undefined) {
    const h = createHash('sha256')
    for (const f of CODE_FILES) {
      try {
        h.update(readFileSync(new URL(`./${f}`, import.meta.url)))
      } catch {
        h.update('none')
      }
    }
    codeStamp = h.digest('hex')
  }
  return codeStamp
}

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
  return createHash('sha256').update(JSON.stringify([code(), ...parts])).digest('hex')
}

function srcPath(cacheDir: string, key: string): string {
  return join(cacheDir, `s-${key}.json`)
}

// The cached conversion, or null. A hit is touched so it ages with its PNGs
// (so expiry is by last use, not by creation).
export function srcGet(cacheDir: string, key: string): CleanSvg | null {
  const p = srcPath(cacheDir, key)
  try {
    const v = JSON.parse(readFileSync(p, 'utf8')) as Partial<CleanSvg>
    if (typeof v.svg !== 'string') return null
    const clean = sanitizeSvg(v.svg, MAX_CONVERTED_BYTES)
    if (!clean) return null
    const now = new Date()
    utimesSync(p, now, now)
    return clean
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
