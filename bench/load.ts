// Load and memory bench: wall time and RSS of one process as it picks up the
// renderer, then MathJax, then Mermaid. Each stage runs in a fresh process
// that does everything up to it, so the numbers are what a Pi session or a
// Neovim renderer adds.
//
//   node bench/load.ts

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const CHILD = fileURLToPath(new URL('./load-child.ts', import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'artbench-load-'))
process.on('exit', () => rmSync(root, { recursive: true, force: true }))
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
function sample(upto: string, warmDisk: boolean, i: number): Record<string, number> {
  const dir = join(root, `${upto}-${warmDisk ? 'w' : 'c'}-${i}`)
  if (warmDisk) spawnSync(process.execPath, ['--expose-gc', CHILD, upto, dir])
  const r = spawnSync(process.execPath, ['--expose-gc', CHILD, upto, dir], { encoding: 'utf8' })
  return JSON.parse(r.stdout.trim().split('\n').pop()!)
}

console.log('Per-process cost of the renderer (median of 5; RSS in MB, time in ms)')
console.log('stage                          cache   RSS    +RSS   stage ms')
const base = median(Array.from({ length: 5 }, (_, i) => sample('load', false, i).start))
console.log(`${'bare node'.padEnd(30)} ${'-'.padEnd(6)} ${base.toFixed(0).padStart(4)}`)
for (const [label, upto, key] of [
  ['import + Renderer', 'load', 'loaded'],
  ['first math block (MathJax)', 'math', 'math'],
  ['first Mermaid diagram (worker)', 'mermaid', 'mermaid'],
] as const) {
  for (const warm of upto === 'load' ? [false] : [false, true]) {
    const rs = Array.from({ length: 5 }, (_, i) => sample(upto, warm, i))
    const rss = median(rs.map((r) => r[key]!))
    const ms = median(rs.map((r) => (key === 'loaded' ? r.load_ms! : r[`${key}_ms`]!)))
    console.log(`${label.padEnd(30)} ${(upto === 'load' ? '-' : warm ? 'warm' : 'empty').padEnd(6)} ${rss.toFixed(0).padStart(4)} ${('+' + (rss - base).toFixed(0)).padStart(6)} ${ms.toFixed(0).padStart(8)}`)
  }
}
