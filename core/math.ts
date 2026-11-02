// Display math: TeX to SVG through the bundled MathJax. The bundle loads on
// first use.

import { createRequire } from 'node:module'
import { MAX_CONVERTED_BYTES, sanitizeSvg, type CleanSvg } from './svg.ts'

interface MathBundle {
  texToSvg(tex: string, display?: boolean): string
}

let bundle: MathBundle | null | undefined

function load(): MathBundle | null {
  if (bundle === undefined) {
    try {
      bundle = createRequire(import.meta.url)('./vendor/mathjax.cjs') as MathBundle
    } catch {
      bundle = null
    }
  }
  return bundle
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
export function mathToSvg(body: string, color: string, display = true): CleanSvg | null {
  const tex = normalizeTex(body)
  if (!tex || tex.length > MAX_TEX) return null
  const mj = load()
  if (!mj) return null
  let raw: string
  try {
    raw = mj.texToSvg(tex, display)
  } catch {
    return null
  }
  // Attribute syntax only, so \text{href} still draws.
  if (/\shref\s*=/i.test(raw)) return null
  const clean = sanitizeSvg(raw, MAX_CONVERTED_BYTES)
  if (!clean) return null
  return { ...clean, svg: clean.svg.replace(/^<svg\b/, `<svg color="${color}"`) }
}
