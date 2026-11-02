// Worker thread for beautiful-mermaid, bundled by esbuild into
// core/vendor/mermaid-worker.cjs. The layout engine is synchronous and can
// run for minutes on a dense graph, so it lives here, where the host can
// terminate it. One request in, one raw SVG string (or null) out.

import { parentPort } from 'node:worker_threads'
import { renderMermaidSVG, THEMES } from 'beautiful-mermaid'

parentPort!.on('message', (m: { source: string; card: string }) => {
  let svg: string | null = null
  try {
    const out = renderMermaidSVG(m.source, {
      ...THEMES['catppuccin-mocha'],
      bg: m.card,
      muted: '#9399b2',
      transparent: true,
    })
    svg = typeof out === 'string' ? out : null
  } catch {}
  parentPort!.postMessage({ svg })
})
