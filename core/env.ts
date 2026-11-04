// Terminal facts: can we draw pictures, and how big is a cell. Everything
// goes through `run`, so tests can fake tmux. Nothing queries the terminal.

import { spawnSync } from 'node:child_process'
import { INDENT, MATH_INDENT, type Cell } from './layout.ts'

export type Run = (cmd: string, args: string[]) => string | null

export const defaultRun: Run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 1500 })
  return r.status === 0 && typeof r.stdout === 'string' ? r.stdout.trim() : null
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
  const a = detect(env, run)
  if (!a.ok) return a
  // AR_TERM_RENDER_TRANSPORT=inline|file forces the transport.
  const forced = env.AR_TERM_RENDER_TRANSPORT
  const mode = forced === 'inline' || forced === 'file' ? forced : (a.mode ?? 'inline')
  return { ...a, mode }
}

function detect(env: NodeJS.ProcessEnv, run: Run): Availability {
  const override = env.AR_TERM_RENDER_IMAGES
  if (override === '0') return { ok: false, reason: 'AR_TERM_RENDER_IMAGES=0' }
  if (override === '1') return { ok: true, reason: 'AR_TERM_RENDER_IMAGES=1', mode: 'inline' }

  if (env.TMUX) {
    const viewer = run('tmux', ['show', '-gv', '@viewer'])
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
    const term = (run('tmux', ['display', '-p', '#{client_termname}']) ?? '').toLowerCase()
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
  const out = run('tmux', ['display', '-p', '#{client_cell_width} #{client_cell_height}'])
  if (!out) return null
  const [w, h] = out.split(/\s+/).map(Number)
  return w && h && w > 0 && h > 0 ? { w, h } : null
}

// Left indents in cells, each an integer 0-8, else its default:
// AR_TERM_RENDER_INDENT for figures, AR_TERM_RENDER_MATH_INDENT for math.
export const MAX_INDENT = 8

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
