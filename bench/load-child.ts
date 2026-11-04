// One stage of bench/load.ts, run in a fresh process: loads the renderer, then
// whatever `upto` names (load, math, mermaid), and prints the time and RSS of
// each step as JSON.

import process from 'node:process'

const MERMAID = 'graph LR\n  A[Start] --> B{Choice}\n  B -->|yes| C[Done]\n  B -->|no| D[Retry]\n  D --> B'

// Collected first, so garbage a stage left behind does not count as its memory.
const rssMb = (): number => {
  ;(globalThis as { gc?: () => void }).gc?.()
  return process.memoryUsage().rss / 1048576
}

const upto = process.argv[2]!
const cacheDir = process.argv[3]!
// The Mermaid worker is unref'd, so something else must hold the loop open.
const hold = setInterval(() => {}, 1000)
const t0 = performance.now()
const out: Record<string, number> = { start: rssMb() }
const { Renderer } = await import('../core/index.ts')
const r = new Renderer({ write: () => {}, env: { AR_TERM_RENDER_IMAGES: '1', AR_TERM_RENDER_TRANSPORT: 'file' }, cacheDir, cellFallback: () => ({ w: 10, h: 20 }) })
out.load_ms = performance.now() - t0
out.loaded = rssMb()

const step = async (name: string, md: string): Promise<void> => {
  const t = performance.now()
  r.transform(md, { width: 100 })
  await r.idle()
  out[`${name}_ms`] = performance.now() - t
  out[name] = rssMb()
}
if (upto === 'math' || upto === 'mermaid') await step('math', '$$\nx^2 + \\frac{a}{b}\n$$')
if (upto === 'mermaid') await step('mermaid', '```mermaid\n' + MERMAID + '\n```')
clearInterval(hold)
console.log(JSON.stringify(out))
process.exit(0)
