// Display math: TeX to SVG through the bundled MathJax. The bundle loads on
// first use.

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { mark, marked } from './raster.ts'
import { bundleStamp, srcGet, srcKey, srcPut } from './srccache.ts'
import { MAX_CONVERTED_BYTES, sanitizeSvg, type CleanSvg } from './svg.ts'

interface MathBundle {
  texToSvg(tex: string, display?: boolean): string
}

const BUNDLE = fileURLToPath(new URL('./vendor/mathjax.cjs', import.meta.url))

let bundle: MathBundle | null | undefined

function load(): MathBundle | null {
  if (bundle === undefined) {
    try {
      bundle = createRequire(import.meta.url)(BUNDLE) as MathBundle
    } catch {
      bundle = null
    }
  }
  return bundle
}

// Whether MathJax is already loaded, so a conversion costs milliseconds
// rather than the load.
export function mathLoaded(): boolean {
  return Boolean(bundle)
}

const MAX_TEX = 8000

// MathJax runs without equation numbering, so a \tag becomes trailing text.
export function normalizeTex(body: string): string {
  let tex = body.trim()
  let tag = ''
  tex = tex.replace(/\\tag(\*)?\s*\{([^{}]*)\}/g, (_m, star: string | undefined, label: string) => {
    tag = star ? label : `(${label})`
    return ''
  })
  if (tag) tex += `\\qquad\\text{${tag}}`
  return tex
}

// Returns a sized SVG drawn in `color`, or null when the TeX does not parse.
// With `cacheDir`, a conversion an earlier process made is read back instead
// of run, which also keeps MathJax from loading; refusals are remembered too.
export function mathToSvg(body: string, color: string, display = true, cacheDir?: string): CleanSvg | null {
  const tex = normalizeTex(body)
  if (!tex || tex.length > MAX_TEX) return null
  const key = cacheDir ? srcKey('math', bundleStamp(BUNDLE), display, color, tex) : null
  if (cacheDir && key) {
    const hit = srcGet(cacheDir, key)
    if (hit) return hit
    if (marked(cacheDir, `src:${key}`)) return null
  }
  const mj = load()
  if (!mj) return null
  const clean = convert(mj, tex, display, color)
  if (cacheDir && key) {
    if (clean) srcPut(cacheDir, key, clean)
    else mark(cacheDir, `src:${key}`)
  }
  return clean
}

function convert(mj: MathBundle, tex: string, display: boolean, color: string): CleanSvg | null {
  let raw: string
  try {
    raw = mj.texToSvg(tex, display)
  } catch {
    return null
  }
  // Attribute syntax only, so \text{href} still draws.
  if (/\shref\s*=/i.test(raw)) return null
  // The color goes in before sanitizing, so a cached copy sanitized again on
  // read comes back identical.
  return sanitizeSvg(raw.replace(/^<svg\b/, `<svg color="${color}"`), MAX_CONVERTED_BYTES)
}
