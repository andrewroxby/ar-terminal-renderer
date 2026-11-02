// ar-term-render for Pi: draws figures in assistant messages through
// registerMarkdownTransformer. adapter.ts holds the wiring; this entry point
// only supplies Pi's cell-size fallback.

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { getCellDimensions } from '@earendil-works/pi-tui'
import { install } from './adapter.ts'

export default function render(pi: ExtensionAPI): void {
  install(pi, {
    cellFallback: () => {
      try {
        const c = getCellDimensions()
        return { w: c.widthPx, h: c.heightPx }
      } catch {
        return undefined
      }
    },
  })
}
