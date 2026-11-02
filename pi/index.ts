// ar-term-render for Pi: draws figures in assistant messages through
// registerMarkdownTransformer. The core owns detection, rendering and the
// kitty transport; this file wires it to Pi's hooks.

import { spawn, type ChildProcess } from 'node:child_process'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { getCellDimensions } from '@earendil-works/pi-tui'
import { GUIDANCE, Renderer, cardColor } from '../core/index.ts'

export default function render(pi: ExtensionAPI): void {
  let theme: ExtensionContext['ui']['theme'] | undefined

  const renderer = new Renderer({
    write: (data) => {
      if (process.stdout.isTTY) process.stdout.write(data)
    },
    cellFallback: () => {
      try {
        const c = getCellDimensions()
        return { w: c.widthPx, h: c.heightPx }
      } catch {
        return undefined
      }
    },
    card: () => {
      try {
        return cardColor(theme?.getBgAnsi('toolPendingBg'))
      } catch {
        return cardColor(undefined)
      }
    },
  })

  pi.registerMarkdownTransformer((markdown, ctx) =>
    ctx.messageType === 'assistant' ? renderer.transform(markdown, { width: ctx.availableWidth }) : markdown,
  )

  pi.on('before_agent_start', (event, ctx) => {
    theme = ctx.ui.theme
    if (!renderer.enabled || !renderer.available().ok) return undefined
    return { systemPrompt: `${event.systemPrompt}\n\n${GUIDANCE}` }
  })

  // tmux-viewer signals `wait-for viewer-changed` when the attached client
  // changes. A client that attached late has no image data, so send it all.
  let watcher: ChildProcess | undefined
  let stopped = false
  const watch = (): void => {
    if (stopped || !process.env.TMUX) return
    const started = Date.now()
    const child = spawn('tmux', ['wait-for', 'viewer-changed'], { stdio: 'ignore' })
    watcher = child
    child.unref()
    child.on('error', () => {})
    child.on('exit', (code) => {
      if (stopped) return
      if (code === 0) renderer.redraw()
      // A failing wait (server gone) must not spin.
      const delay = code === 0 && Date.now() - started > 200 ? 0 : 10_000
      const t = setTimeout(watch, delay)
      t.unref()
    })
  }

  pi.on('session_start', (_event, ctx) => {
    theme = ctx.ui.theme
    stopped = false
    if (!watcher) watch()
  })
  pi.on('session_shutdown', () => {
    stopped = true
    watcher?.kill()
    watcher = undefined
  })

  pi.registerCommand('render', {
    description: 'Inline figures: /render on|off|redraw|status',
    handler: (args, ctx) => {
      const arg = args.trim().toLowerCase()
      if (arg === 'on' || arg === 'off') {
        renderer.enabled = arg === 'on'
        ctx.ui.notify(`render ${arg} (applies to messages drawn from now on)`, 'info')
      } else if (arg === 'redraw') {
        ctx.ui.notify(`render: resent ${renderer.redraw()} image(s)`, 'info')
      } else if (arg === '' || arg === 'status') {
        const s = renderer.status()
        ctx.ui.notify(
          `render: ${s.enabled ? 'on' : 'off'}; graphics ${s.available.ok ? 'yes' : 'no'} (${s.available.reason}); cell ${s.cell.w}x${s.cell.h}; ${s.images} image(s); cache ${s.cacheDir}`,
          'info',
        )
      } else {
        ctx.ui.notify('usage: /render on|off|redraw|status', 'warning')
      }
    },
  })
}
