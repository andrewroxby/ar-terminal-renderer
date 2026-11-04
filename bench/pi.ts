// Pi bench: boots a real Pi in a private tmux server (killed afterwards) on a
// throwaway agent dir and TMPDIR.
//
//   node bench/pi.ts [--quick]
//
// 1. Extension load: Pi's own startup timings for the extension's module
//    import and factory, with and without a warm TMPDIR (Pi's TypeScript
//    loader caches there).
// 2. Resume: a session of 20 assistant replies that carry figures or math is
//    opened with bench/pi-probe.ts, which times every markdown transform
//    Pi runs. Shows how many calls a resume makes and what they cost, with an
//    empty renderer cache and with the PNGs from an earlier run.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { message } from './messages.ts'

const ROOT = resolve(import.meta.dirname, '..')
const SOCK = `artbench-pi-${process.pid}`
const quick = process.argv.includes('--quick')
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!

const dir = mkdtempSync(join(tmpdir(), 'artbench-pi-'))
const T = (...a: string[]) => spawnSync('tmux', ['-L', SOCK, '-f', '/dev/null', ...a], { encoding: 'utf8' })
process.on('exit', () => {
  T('kill-server')
  rmSync(dir, { recursive: true, force: true })
})

// A session of n user/assistant pairs, each reply with `extra` content.
function session(n: number, extra: 'figs3' | 'math12' | 'none'): string {
  const lines = [JSON.stringify({ type: 'session', version: 3, id: 'a0000000-0000-7000-8000-000000000001', timestamp: '2026-01-01T00:00:00.000Z', cwd: dir })]
  let parent: string | null = null
  const add = (id: string, msg: object): void => {
    lines.push(JSON.stringify({ type: 'message', id, parentId: parent, timestamp: '2026-01-01T00:00:01.000Z', message: msg }))
    parent = id
  }
  for (let i = 0; i < n; i++) {
    add(`u${String(i).padStart(7, '0')}`, { role: 'user', content: [{ type: 'text', text: `question ${i}` }], timestamp: 1767225601000 + i })
    add(`a${String(i).padStart(7, '0')}`, {
      role: 'assistant',
      content: [{ type: 'text', text: message(6000, extra, i + 1) }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop',
      timestamp: 1767225602000 + i,
    })
  }
  return lines.join('\n') + '\n'
}

function run(label: string, ext: boolean, sessionFile: string, tmp: string): { init: number; total: number; imp: number; factory: number } | null {
  const out = join(dir, 'out.txt')
  rmSync(out, { force: true })
  const sh = join(dir, 'run.sh')
  writeFileSync(
    sh,
    `#!/bin/sh
cd ${dir}
export PI_CODING_AGENT_DIR=${dir}/agent PI_TIMING=1 PI_STARTUP_BENCHMARK=1 TMPDIR=${tmp}
pi ${ext ? `-e ${ROOT}/pi/index.ts` : ''} --no-extensions --no-skills --no-context-files --no-prompt-templates --no-themes --no-session --session ${sessionFile} --offline 2> ${out}
echo FINISHED >> ${out}
`,
    { mode: 0o755 },
  )
  T('kill-server')
  T('new-session', '-d', '-x', '140', '-y', '50', sh)
  for (let i = 0; i < 200; i++) {
    spawnSync('sleep', ['0.1'])
    if (existsSync(out) && readFileSync(out, 'utf8').includes('FINISHED')) break
  }
  const text = existsSync(out) ? readFileSync(out, 'utf8') : ''
  T('kill-server')
  const num = (re: RegExp): number => Number(re.exec(text)?.[1] ?? NaN)
  const r = { init: num(/interactiveMode\.init: (\d+)ms/), total: num(/Startup Timings: main ---[\s\S]*?TOTAL: (\d+)ms/), imp: num(/module import: (\d+)ms/), factory: num(/factory: (\d+)ms/) }
  return Number.isNaN(r.init) ? (console.log(`${label}: no timings\n${text.slice(-400)}`), null) : r
}

mkdirSync(join(dir, 'agent'))
writeFileSync(join(dir, 'agent', 'settings.json'), '{}')

const N = quick ? 3 : 7
console.log(`Extension load (ms, median of ${N}): Pi's own startup timings`)
console.log('TMPDIR        module import  factory')
{
  const file = join(dir, 'empty.jsonl')
  writeFileSync(file, session(0, 'none'))
  for (const [name, wipe] of [['empty', true], ['warm', false]] as const) {
    const cache = join(dir, `load-${name}`)
    const rs: NonNullable<ReturnType<typeof run>>[] = []
    for (let i = 0; i < N; i++) {
      if (wipe) rmSync(cache, { recursive: true, force: true })
      mkdirSync(cache, { recursive: true })
      const r = run(name, true, file, cache)
      if (r) rs.push(r)
    }
    if (rs.length) console.log(`${name.padEnd(13)} ${String(median(rs.map((r) => r.imp))).padStart(9)} ${String(median(rs.map((r) => r.factory))).padStart(8)}`)
  }
}

// Opens the session with the probe loaded and collects the transform log.
function resume(file: string, tmp: string): { calls: number; assistant: number; first: number; second: number; max: number } | null {
  const log = join(dir, 'probe.jsonl')
  rmSync(log, { force: true })
  const copy = join(dir, 'resume.jsonl')
  writeFileSync(copy, readFileSync(file))
  const sh = join(dir, 'resume.sh')
  writeFileSync(
    sh,
    `#!/bin/sh
cd ${dir}
export PI_CODING_AGENT_DIR=${dir}/agent TMPDIR=${tmp} AR_BENCH_LOG=${log} AR_TERM_RENDER_IMAGES=1 AR_TERM_RENDER_TRANSPORT=file
exec pi -e ${ROOT}/bench/pi-probe.ts --no-extensions --no-skills --no-context-files --no-prompt-templates --no-themes --session ${copy} --offline
`,
    { mode: 0o755 },
  )
  T('kill-server')
  T('new-session', '-d', '-x', '140', '-y', '50', sh)
  let last = 0
  let still = 0
  for (let i = 0; i < 160 && still < 8; i++) {
    spawnSync('sleep', ['0.25'])
    const n = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0
    still = n === last && n > 0 ? still + 1 : 0
    last = n
  }
  T('kill-server')
  if (!existsSync(log)) return null
  const rows = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { ms: number; type: string })
  const a = rows.filter((r) => r.type === 'assistant')
  const sum = (xs: { ms: number }[]): number => xs.reduce((t, r) => t + r.ms, 0)
  const half = Math.floor(a.length / 2)
  return { calls: rows.length, assistant: a.length, first: sum(a.slice(0, half)), second: sum(a.slice(half)), max: Math.max(...a.map((r) => r.ms)) }
}

console.log(`\nResume a session of 20 replies: Pi's markdown transforms (ms, median of ${quick ? 2 : 3})`)
console.log('content   cache        calls  first pass  second pass  slowest call')
for (const extra of ['figs3', 'math12'] as const) {
  const file = join(dir, `r-${extra}.jsonl`)
  writeFileSync(file, session(20, extra))
  for (const mode of ['empty', 'warm'] as const) {
    const rs: NonNullable<ReturnType<typeof resume>>[] = []
    for (let i = 0; i < (quick ? 2 : 3); i++) {
      const cache = join(dir, `resume-${extra}-${mode}-${i}`)
      rmSync(cache, { recursive: true, force: true })
      mkdirSync(cache, { recursive: true })
      // Warm: one earlier run fills the PNG cache and Pi's loader cache.
      if (mode === 'warm') resume(file, cache)
      const r = resume(file, cache)
      if (r) rs.push(r)
    }
    if (!rs.length) continue
    const m = (k: 'calls' | 'first' | 'second' | 'max'): number => median(rs.map((r) => r[k]))
    console.log(`${extra.padEnd(9)} ${mode.padEnd(11)} ${String(m('calls')).padStart(5)} ${m('first').toFixed(0).padStart(10)} ${m('second').toFixed(0).padStart(12)} ${m('max').toFixed(0).padStart(12)}`)
  }
}
