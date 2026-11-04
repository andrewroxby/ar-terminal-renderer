// Pi transform bench: what Renderer.transform costs per call, cold and warm,
// and when a message grows token by token. No dependencies.
//
//   node bench/transform.ts            all sections
//   node bench/transform.ts --quick    fewer samples, skips the 100 KB cold runs
//
// Cold cases run in a child process each, so they include MathJax's load.
// Everything draws into a private cache directory that is removed on exit.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { Renderer } from '../core/render.ts'
import { message, type Extra } from './messages.ts'

const SELF = fileURLToPath(import.meta.url)
const WIDTH = 100
const ENV = { AR_TERM_RENDER_IMAGES: '1', AR_TERM_RENDER_TRANSPORT: 'file' } as NodeJS.ProcessEnv

// ---- stats ----

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
const p95 = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))]!
const fmt = (ms: number): string => (ms < 1 ? ms.toFixed(3) : ms < 100 ? ms.toFixed(2) : ms.toFixed(0))

function renderer(cacheDir: string, extra: Partial<ConstructorParameters<typeof Renderer>[0]> = {}): Renderer {
  return new Renderer({ write: () => {}, env: ENV, cacheDir, cellFallback: () => ({ w: 10, h: 20 }), ...extra })
}

async function settle(r: Renderer, text: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    r.transform(text, { width: WIDTH })
    if (!r.pending()) return
    await r.idle()
  }
}

function time<T>(fn: () => T): [number, T] {
  const t0 = performance.now()
  const v = fn()
  return [performance.now() - t0, v]
}

// ---- child: one cold or process-cold sample ----

async function child(mode: string, bytes: number, extra: Extra, cacheDir: string): Promise<void> {
  // The renderer's background timer is unref'd, so something must hold the loop.
  const hold = setInterval(() => {}, 1000)
  const text = message(bytes, extra)
  const r = renderer(cacheDir)
  const [first] = time(() => r.transform(text, { width: WIDTH }))
  const t0 = performance.now()
  await r.idle()
  const total = first + (performance.now() - t0)
  // A second pass shows how long the picture-ready call takes.
  const [second] = time(() => r.transform(text, { width: WIDTH }))
  clearInterval(hold)
  console.log(JSON.stringify({ mode, first, total, second }))
  process.exit(0)
}

function sample(mode: string, bytes: number, extra: Extra, cacheDir: string): { first: number; total: number; second: number } {
  const r = spawnSync(process.execPath, [SELF, '--child', mode, String(bytes), extra, cacheDir], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr)
  return JSON.parse(r.stdout.trim().split('\n').pop()!)
}

// ---- sections ----

const quick = process.argv.includes('--quick')
const SIZES = [2_000, 20_000, 100_000]
const EXTRAS: [Extra, string][] = [['none', '0 figs/math'], ['figs3', '3 figs'], ['math12', '12 math']]
const kb = (n: number): string => `${n / 1000} KB`

async function warmTable(root: string): Promise<void> {
  console.log('\n## warm: repeated transform of an unchanged message (memo hit), ms per call')
  console.log('size    content        median    p95     max')
  const rows: [number, Extra, string, boolean][] = []
  for (const b of SIZES) for (const [e, label] of EXTRAS) rows.push([b, e, label, false])
  rows.push([20_000, 'none', 'no markers', true])
  for (const [b, e, label, plain] of rows) {
    const text = message(b, e, 1, plain)
    const r = renderer(join(root, `warm-${b}-${e}-${plain}`))
    await settle(r, text)
    const n = b >= 100_000 ? 200 : 600
    const xs: number[] = []
    for (let i = 0; i < n; i++) xs.push(time(() => r.transform(text, { width: WIDTH }))[0])
    console.log(`${kb(b).padEnd(7)} ${label.padEnd(14)} ${fmt(median(xs)).padStart(7)} ${fmt(p95(xs)).padStart(7)} ${fmt(Math.max(...xs)).padStart(7)}`)
  }
}

async function coldTable(root: string): Promise<void> {
  console.log('\n## cold: first transform in a fresh process (ms; sync = the call, total = until background renders end)')
  console.log('size    content        empty cache: sync   total   |  disk-warm: sync   total  |  2nd call')
  for (const b of SIZES) {
    for (const [e, label] of EXTRAS) {
      if (e === 'none' || (quick && b > 20_000)) continue
      const n = quick ? 2 : 5
      const cold: ReturnType<typeof sample>[] = []
      const warm: ReturnType<typeof sample>[] = []
      for (let i = 0; i < n; i++) {
        const dir = join(root, `cold-${b}-${e}-${i}`)
        cold.push(sample('cold', b, e, dir))
        warm.push(sample('warm', b, e, dir))
      }
      const m = (xs: ReturnType<typeof sample>[], k: 'first' | 'total' | 'second'): string => fmt(median(xs.map((x) => x[k]))).padStart(7)
      console.log(`${kb(b).padEnd(7)} ${label.padEnd(14)} ${m(cold, 'first')} ${m(cold, 'total')}         |  ${m(warm, 'first')} ${m(warm, 'total')}       | ${m(warm, 'second')}`)
    }
  }
}

// The message grows by `step` characters per call, as tokens arrive; each
// call sees the whole text so far, as Pi's Markdown does.
async function streamTable(root: string): Promise<void> {
  console.log('\n## streaming: ms per call as the message grows 24 chars at a time')
  console.log('size    content        caches   calls  median    p95     max   total')
  for (const b of SIZES) {
    for (const [e, label] of EXTRAS) {
      const text = message(b, e, 2)
      for (const warm of [true, false]) {
        if (!warm && e === 'none') continue
        if (!warm && quick) continue
        const dir = join(root, `stream-${b}-${e}-${warm}`)
        const r = renderer(dir)
        if (warm) await settle(r, text)
        const xs: number[] = []
        for (let n = 24; n < text.length + 24; n += 24) xs.push(time(() => r.transform(text.slice(0, n), { width: WIDTH, streaming: n < text.length }))[0])
        const total = xs.reduce((a, c) => a + c, 0)
        console.log(
          `${kb(b).padEnd(7)} ${label.padEnd(14)} ${(warm ? 'warm' : 'cold').padEnd(6)} ${String(xs.length).padStart(6)} ${fmt(median(xs)).padStart(7)} ${fmt(p95(xs)).padStart(7)} ${fmt(Math.max(...xs)).padStart(7)} ${fmt(total).padStart(7)}`,
        )
        r.forget()
      }
    }
  }
}

// Graphics detection under tmux spawns `tmux` on the render path; this shows
// what that costs against a private server.
async function detectTable(): Promise<void> {
  console.log('\n## graphics detection under tmux (private server), ms')
  const sock = `artbench-${process.pid}`
  const T = (...a: string[]) => spawnSync('tmux', ['-L', sock, '-f', '/dev/null', ...a], { encoding: 'utf8' })
  if (T('new-session', '-d', '-x', '120', '-y', '40').status !== 0) return void console.log('tmux unavailable, skipped')
  try {
    const path = T('display', '-p', '#{socket_path},#{pid},0').stdout.trim()
    T('set', '-g', '@viewer', 'transport=local device=home client=terminal graphics=file')
    const dir = join(tmpdir(), `artbench-detect-${process.pid}`)
    const make = (now: () => number): Renderer =>
      new Renderer({ write: () => {}, env: { TMUX: path } as NodeJS.ProcessEnv, cacheDir: dir, cellFallback: () => ({ w: 10, h: 20 }), now })
    // The first lookup of each, which has to run tmux.
    const a0: number[] = []
    const c0: number[] = []
    for (let i = 0; i < 10; i++) {
      const r = make(() => 0)
      a0.push(time(() => r.available())[0])
      c0.push(time(() => r.cell())[0])
    }
    // The same calls once the 2 s memo has run out.
    let clock = 0
    const r = make(() => clock)
    r.available()
    r.cell()
    const a: number[] = []
    const c: number[] = []
    for (let i = 0; i < 15; i++) {
      clock += 3000
      a.push(time(() => r.available())[0])
      c.push(time(() => r.cell())[0])
      await new Promise((res) => setTimeout(res, 20))
    }
    console.log(`first lookup:       available() median ${fmt(median(a0))}  p95 ${fmt(p95(a0))}   cell() median ${fmt(median(c0))}  p95 ${fmt(p95(c0))}`)
    console.log(`after memo expiry:  available() median ${fmt(median(a))}  p95 ${fmt(p95(a))}   cell() median ${fmt(median(c))}  p95 ${fmt(p95(c))}`)
    rmSync(join(tmpdir(), `artbench-detect-${process.pid}`), { recursive: true, force: true })
  } finally {
    T('kill-server')
  }
}

if (process.argv[2] === '--child') {
  await child(process.argv[3]!, Number(process.argv[4]), process.argv[5] as Extra, process.argv[6]!)
} else {
  const root = mkdtempSync(join(tmpdir(), 'artbench-'))
  process.on('exit', () => rmSync(root, { recursive: true, force: true }))
  await detectTable()
  await warmTable(root)
  await streamTable(root)
  await coldTable(root)
}
