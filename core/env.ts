// Terminal facts: can we draw pictures, and how big is a cell. Everything
// goes through `run`, so tests can fake tmux. Nothing queries the terminal.

import { execFile, spawnSync } from 'node:child_process'
import { INDENT, MATH_INDENT, type Cell } from './layout.ts'

export type Run = (cmd: string, args: string[]) => string | null
export type RunAsync = (cmd: string, args: string[]) => Promise<string | null>

export const defaultRun: Run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 1500 })
  return r.status === 0 && typeof r.stdout === 'string' ? r.stdout.trim() : null
}

export const defaultRunAsync: RunAsync = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: 1500 }, (err, stdout) => resolve(err ? null : stdout.trim()))
  })

// The probes below are written once as generators that ask for a command's
// output with `yield`, and run either way: straight through with a Run, or
// without blocking with a RunAsync.
type Step = [cmd: string, args: string[]]
type Probe<T> = Generator<Step, T, string | null>

function drive<T>(g: Probe<T>, run: Run): T {
  let r = g.next()
  while (!r.done) r = g.next(run(...r.value))
  return r.value
}

async function driveAsync<T>(g: Probe<T>, run: RunAsync): Promise<T> {
  let r = g.next()
  while (!r.done) r = g.next(await run(...r.value))
  return r.value
}

// mode says how image data should travel: `file` hands the terminal a path
// (a local client sharing this filesystem), `inline` sends the bytes.
export interface Availability {
  ok: boolean
  reason: string
  mode?: 'file' | 'inline'
}

const KITTY_TERMS = ['ghostty', 'kitty', 'wezterm']

export function detectGraphics(env: NodeJS.ProcessEnv, run: Run): Availability {
  return drive(probeGraphics(env), run)
}

export function detectGraphicsAsync(env: NodeJS.ProcessEnv, run: RunAsync): Promise<Availability> {
  return driveAsync(probeGraphics(env), run)
}

function* probeGraphics(env: NodeJS.ProcessEnv): Probe<Availability> {
  const a = yield* detect(env)
  if (!a.ok) return a
  // AR_TERM_RENDER_TRANSPORT=inline|file forces the transport.
  const forced = env.AR_TERM_RENDER_TRANSPORT
  const mode = forced === 'inline' || forced === 'file' ? forced : (a.mode ?? 'inline')
  return { ...a, mode }
}

function* detect(env: NodeJS.ProcessEnv): Probe<Availability> {
  const override = env.AR_TERM_RENDER_IMAGES
  if (override === '0') return { ok: false, reason: 'AR_TERM_RENDER_IMAGES=0' }
  if (override === '1') return { ok: true, reason: 'AR_TERM_RENDER_IMAGES=1', mode: 'inline' }

  if (env.TMUX) {
    const viewer = yield ['tmux', ['show', '-gv', '@viewer']]
    if (viewer) {
      const kv = new Map(
        viewer.split(/\s+/).map((p) => {
          const i = p.indexOf('=')
          return i < 0 ? [p, ''] : [p.slice(0, i), p.slice(i + 1)]
        }) as [string, string][],
      )
      if (kv.get('transport') === 'none') return { ok: false, reason: 'no viewer attached' }
      const g = kv.get('graphics')
      if (g === 'file' || g === 'inline') return { ok: true, reason: `viewer graphics=${g}`, mode: g }
      if (g === 'no') return { ok: false, reason: 'viewer graphics=no' }
    }
    const term = ((yield ['tmux', ['display', '-p', '#{client_termname}']]) ?? '').toLowerCase()
    return KITTY_TERMS.some((t) => term.includes(t))
      ? { ok: true, reason: `tmux client ${term}` }
      : { ok: false, reason: `tmux client ${term || 'unknown'}` }
  }

  const term = `${env.TERM ?? ''} ${env.TERM_PROGRAM ?? ''}`.toLowerCase()
  const kitty =
    env.KITTY_WINDOW_ID !== undefined ||
    env.GHOSTTY_RESOURCES_DIR !== undefined ||
    KITTY_TERMS.some((t) => term.includes(t))
  return kitty ? { ok: true, reason: 'kitty-graphics terminal' } : { ok: false, reason: 'terminal not recognized' }
}

// Pixel size of one cell as reported by the attached tmux client, or null
// when unset (headless clients report 0).
export function tmuxCell(run: Run): Cell | null {
  return drive(probeCell(), run)
}

export function tmuxCellAsync(run: RunAsync): Promise<Cell | null> {
  return driveAsync(probeCell(), run)
}

function* probeCell(): Probe<Cell | null> {
  const out = yield ['tmux', ['display', '-p', '#{client_cell_width} #{client_cell_height}']]
  if (!out) return null
  const [w, h] = out.split(/\s+/).map(Number)
  return w && h && w > 0 && h > 0 ? { w, h } : null
}

// Left indents in cells, each an integer 0-8, else its default:
// AR_TERM_RENDER_INDENT for figures, AR_TERM_RENDER_MATH_INDENT for math.
const MAX_INDENT = 8

function indentVar(v: string | undefined, fallback: number): number {
  const s = v?.trim()
  if (!s || !/^\d+$/.test(s)) return fallback
  const n = Number(s)
  return n <= MAX_INDENT ? n : fallback
}

export function indentFromEnv(env: NodeJS.ProcessEnv): { figure: number; math: number } {
  return {
    figure: indentVar(env.AR_TERM_RENDER_INDENT, INDENT),
    math: indentVar(env.AR_TERM_RENDER_MATH_INDENT, MATH_INDENT),
  }
}
