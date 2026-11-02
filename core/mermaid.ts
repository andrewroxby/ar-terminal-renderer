// Mermaid to SVG through the bundled beautiful-mermaid, on the dark card.
// Anything it cannot parse (unsupported diagram types, syntax errors) comes
// back null so Pi's own Unicode Mermaid draws the fence.

import { createRequire } from 'node:module'
import { flattenCssVars } from './cssvars.ts'
import { sanitizeSvg, type CleanSvg } from './svg.ts'

interface MermaidBundle {
  renderMermaidSVG(source: string, options: Record<string, unknown>): string
  THEMES: Record<string, Record<string, string>>
}

let bundle: MermaidBundle | null | undefined

function load(): MermaidBundle | null {
  if (bundle === undefined) {
    try {
      bundle = createRequire(import.meta.url)('./vendor/mermaid.cjs') as MermaidBundle
    } catch {
      bundle = null
    }
  }
  return bundle
}

const MAX_SOURCE = 20_000

export function mermaidToSvg(source: string, card: string): CleanSvg | null {
  if (!source.trim() || source.length > MAX_SOURCE) return null
  const mm = load()
  if (!mm) return null
  let raw: string
  try {
    raw = mm.renderMermaidSVG(source, {
      ...mm.THEMES['catppuccin-mocha'],
      bg: card,
      muted: '#9399b2',
      transparent: true,
    })
  } catch {
    return null
  }
  if (typeof raw !== 'string' || !raw.includes('<svg')) return null
  // The default font is not installed; the generic family always resolves.
  const flat = flattenCssVars(raw).replace(/font-family:[^;}]*/g, 'font-family: sans-serif')
  return sanitizeSvg(flat)
}
