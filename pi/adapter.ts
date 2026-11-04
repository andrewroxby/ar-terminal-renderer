// The Pi wiring for ar-term-render. Kept free of Pi package imports (the host
// supplies everything through `pi` and `deps`) so it can be tested directly;
// index.ts is the real entry point.

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Renderer, cardColor, guidance, mathColor, mermaidAvailable } from '../core/index.ts'
import type { Cell, Options } from '../core/index.ts'

interface Deps {
  renderer?: Renderer
  cellFallback?: () => Cell | undefined
  rendererOptions?: Partial<Options>
  spawn?: (cmd: string, args: string[], opts: { stdio: 'ignore' }) => ChildProcess
  setTimeout?: (fn: () => void, ms: number) => { unref?(): void }
  clearTimeout?: (t: unknown) => void
  now?: () => number
  random?: () => number
  env?: NodeJS.ProcessEnv
  mermaidAvailable?: () => boolean
}

const REDRAW_JITTER_MS = 2000
const WATCH_BACKOFF_MS = 10_000

export function install(pi: ExtensionAPI, deps: Deps = {}): Renderer {
  const env = deps.env ?? process.env
  const spawn = deps.spawn ?? ((c, a, o) => nodeSpawn(c, a, o))
  const later = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
  const cancel = deps.clearTimeout ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>))
  const now = deps.now ?? Date.now
  const random = deps.random ?? Math.random

  let theme: ExtensionContext['ui']['theme'] | undefined
  let tui: { invalidate(): void; requestRender(force?: boolean): void } | undefined

  const renderer =
    deps.renderer ??
    new Renderer({
      write: (data) => {
        if (process.stdout.isTTY) process.stdout.write(data)
      },
      env,
      cellFallback: deps.cellFallback,
      card: () => {
        try {
          return cardColor(theme?.getBgAnsi('toolPendingBg'))
        } catch {
          return cardColor(undefined)
        }
      },
      mathColor: () => {
        try {
          return mathColor(theme?.getFgAnsi('text'))
        } catch {
          return mathColor(undefined)
        }
      },
      // A figure that rendered in the background appears when the host
      // rebuilds its transcript.
      onReady: () => {
        tui?.invalidate()
        tui?.requestRender()
      },
      ...deps.rendererOptions,
    })

  pi.registerMarkdownTransformer((markdown, ctx) =>
    ctx.messageType === 'assistant' ? renderer.transform(markdown, { width: ctx.availableWidth, streaming: ctx.isStreaming }) : markdown,
  )

  // The guidance line is decided once per session, at the first turn, so the
  // system prompt (and the prompt cache) stays the same afterwards. /render
  // on|off is the deliberate way to change it.
  let line: string | null | undefined
  pi.on('before_agent_start', (event, ctx) => {
    theme = ctx.ui.theme
    line ??= renderer.enabled && renderer.recheck().ok ? guidance((deps.mermaidAvailable ?? mermaidAvailable)()) : null
    return line ? { systemPrompt: `${event.systemPrompt}\n\n${line}` } : undefined
  })

  // tmux-viewer signals `wait-for viewer-changed` when the attached client
  // changes. A client that attached late has no image data, so send it all,
  // after a random delay so several Pi processes don't send at once.
  let watcher: ChildProcess | undefined
  let stopped = true
  let jitter: unknown
  const watch = (): void => {
    if (stopped || !env.TMUX) return
    const started = now()
    const child = spawn('tmux', ['wait-for', 'viewer-changed'], { stdio: 'ignore' })
    watcher = child
    child.unref?.()
    child.on('error', () => {})
    child.on('exit', (code) => {
      if (stopped || watcher !== child) return
      let delay = WATCH_BACKOFF_MS
      if (code === 0) {
        if (jitter !== undefined) cancel(jitter)
        const t = later(() => {
          jitter = undefined
          renderer.redraw()
        }, Math.floor(random() * REDRAW_JITTER_MS))
        t.unref?.()
        jitter = t
        // A wait that returned at once is a failure, not a signal.
        if (now() - started > 200) delay = 0
      }
      const next = later(watch, delay)
      next.unref?.()
    })
  }

  pi.on('session_start', (_event, ctx) => {
    theme = ctx.ui.theme
    line = undefined
    stopped = false
    renderer.prime()
    // An empty widget is the only way to get at the TUI for rebuilds.
    ctx.ui.setWidget?.('ar-term-render', (handle) => {
      tui = handle
      return { render: () => [], invalidate: () => {} }
    })
    if (!watcher) watch()
  })
  pi.on('session_shutdown', () => {
    stopped = true
    if (jitter !== undefined) cancel(jitter)
    jitter = undefined
    watcher?.kill()
    watcher = undefined
    tui = undefined
    renderer.forget()
  })

  pi.registerCommand('render', {
    description: 'Inline figures: /render on|off|redraw|status',
    handler: (args, ctx) => {
      const arg = args.trim().toLowerCase()
      if (arg === 'on' || arg === 'off') {
        renderer.enabled = arg === 'on'
        line = undefined
        ctx.ui.notify(`render ${arg} (applies to messages drawn from now on)`, 'info')
      } else if (arg === 'redraw') {
        ctx.ui.notify(`render: resent ${renderer.redraw()} image(s)`, 'info')
      } else if (arg === '' || arg === 'status') {
        const s = renderer.status()
        ctx.ui.notify(
          `render: ${s.enabled ? 'on' : 'off'}; graphics ${s.available.ok ? 'yes' : 'no'} (${s.available.reason}${s.available.mode ? `, ${s.available.mode}` : ''}); cell ${s.cell.w}x${s.cell.h}; ${s.images} image(s); cache ${s.cacheDir}`,
          'info',
        )
      } else {
        ctx.ui.notify('usage: /render on|off|redraw|status', 'warning')
      }
    },
  })

  return renderer
}
