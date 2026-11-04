// Neovim bench: time from opening a note with N display and N inline
// formulas to all of them drawn, with a cold and a warm renderer cache, plus
// the cost of a rescan and of cursor moves in insert mode.
//
//   node bench/nvim.ts [--quick]       N = 20 (and 100 unless --quick)
//
// Runs headless Neovim against a private TMPDIR, removed afterwards. Needs
// nvim, node and rsvg-convert.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

const ROOT = resolve(import.meta.dirname, '..')
const quick = process.argv.includes('--quick')
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
const f = (n: number): string => (n < 1 ? n.toFixed(3) : n < 100 ? n.toFixed(2) : n.toFixed(0))

const root = mkdtempSync(join(tmpdir(), 'artbench-nvim-'))
process.on('exit', () => rmSync(root, { recursive: true, force: true }))

interface Result {
  ok: boolean
  drawn_ms: number
  marks: number
  expected: number
  rescan_med: number
  rescan_p95: number
  cursor_med: number
  cursor_p95: number
}

function run(tmp: string, n: number, seed = 0): Result {
  const env: NodeJS.ProcessEnv = { ...process.env, AR_TERM_RENDER_IMAGES: '1', TMPDIR: tmp, AR_BENCH_N: String(n), AR_BENCH_SEED: String(seed) }
  delete env.TMUX
  const r = spawnSync('nvim', ['--headless', '--noplugin', '-u', 'NONE', '-i', 'NONE', '-l', join(ROOT, 'bench/nvim.lua')], { env, encoding: 'utf8', timeout: 180_000 })
  const line = (r.stdout + r.stderr).trim().split('\n').filter((l) => l.startsWith('{')).pop()
  if (!line) throw new Error(`nvim bench failed: ${r.stdout}${r.stderr}`)
  return JSON.parse(line)
}

const reps = quick ? 2 : 5
console.log(`Neovim: open a note with N display + N inline formulas (ms, median of ${reps})`)
console.log('N     cache         all drawn   rescan med  p95    cursor-move med  p95    drawn/expected')
for (const n of quick ? [20] : [20, 100]) {
  for (const mode of ['cold', 'warm'] as const) {
    const rs: Result[] = []
    for (let i = 0; i < reps; i++) {
      // Cold: a new empty cache each run. Warm: the PNGs a previous run left.
      const tmp = join(root, mode === 'cold' ? `c-${n}-${i}` : `w-${n}-${i}`)
      if (mode === 'warm') run(tmp, n)
      rs.push(run(tmp, n))
    }
    const m = (k: keyof Result): number => median(rs.map((r) => r[k] as number))
    console.log(
      `${String(n).padEnd(5)} ${mode.padEnd(12)} ${f(m('drawn_ms')).padStart(9)}   ${f(m('rescan_med')).padStart(9)} ${f(m('rescan_p95')).padStart(6)}   ${f(m('cursor_med')).padStart(11)} ${f(m('cursor_p95')).padStart(6)}    ${rs[0]!.marks}/${rs[0]!.expected}${rs.every((r) => r.ok) ? '' : ' (timeout)'}`,
    )
  }
}
