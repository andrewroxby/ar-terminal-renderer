import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { install } from './adapter.ts'
import { GUIDANCE, Renderer } from '../core/index.ts'

const hasRsvg = spawnSync('rsvg-convert', ['--version']).status === 0

const SVG_MD = '```svg\n<svg viewBox="0 0 200 100"><title>Box</title><rect width="200" height="100"/></svg>\n```'

type Handler = (event: any, ctx: any) => any

function harness(env: NodeJS.ProcessEnv, extra: Record<string, unknown> = {}) {
  const handlers: Record<string, Handler[]> = {}
  const commands: Record<string, (args: string, ctx: any) => unknown> = {}
  let transformer!: (md: string, ctx: any) => string
  const api: any = {
    on: (e: string, h: Handler) => (handlers[e] ??= []).push(h),
    registerMarkdownTransformer: (fn: typeof transformer) => (transformer = fn),
    registerCommand: (n: string, o: { handler: (a: string, c: any) => unknown }) => (commands[n] = o.handler),
  }
  const notes: string[] = []
  const tui = { invalidated: 0, rendered: 0, invalidate() { this.invalidated++ }, requestRender() { this.rendered++ } }
  const widgets: string[] = []
  const ctx = {
    ui: {
      theme: { getBgAnsi: () => '\x1b[48;2;20;20;30m' },
      notify: (m: string) => notes.push(m),
      setWidget: (key: string, factory: (t: typeof tui) => unknown) => {
        widgets.push(key)
        factory(tui)
      },
    },
  }

  // A clock that jumps past the renderer's availability memo on every read.
  let clock = 0
  const now = () => (clock += 5000)
  const writes: string[] = []
  const renderer = new Renderer({ write: (d) => writes.push(d), env, run: () => null, now, cacheDir: mkdtempSync(join(tmpdir(), 'artr-ad-')) })

  const timers: { fn: () => void; ms: number; id: number; cancelled: boolean }[] = []
  const spawned: (EventEmitter & { kill: () => void; killed: boolean; unref: () => void })[] = []
  const deps = {
    renderer,
    env,
    random: () => 0.5,
    now: () => clockWatch,
    setTimeout: (fn: () => void, ms: number) => {
      const t = { fn, ms, id: timers.length, cancelled: false, unref() {} }
      timers.push(t)
      return t
    },
    clearTimeout: (t: any) => void (t.cancelled = true),
    spawn: () => {
      const c: any = new EventEmitter()
      c.killed = false
      c.kill = () => void (c.killed = true)
      c.unref = () => {}
      spawned.push(c)
      return c
    },
    ...extra,
  }
  let clockWatch = 0
  install(api, deps as any)
  return {
    renderer, notes, tui, widgets, ctx, timers, spawned, writes,
    setClock: (v: number) => (clockWatch = v),
    transform: (md: string, messageType: string) => transformer(md, { messageType, isStreaming: false, availableWidth: 80 }),
    fire: (e: string, ev: any = {}) => (handlers[e] ?? []).map((h) => h(ev, ctx)),
    command: (name: string, args: string) => commands[name]!(args, ctx),
    cleanup: () => rmSync(renderer.cacheDir, { recursive: true, force: true }),
  }
}

test('only assistant messages are transformed', () => {
  const h = harness({ AR_TERM_RENDER_IMAGES: '0' })
  const md = `x\n${SVG_MD}\ny`
  assert.equal(h.transform(md, 'user'), md)
  assert.equal(h.transform(md, 'assistant-thinking'), md)
  assert.match(h.transform(md, 'assistant'), /\[figure: Box\]/)
  h.cleanup()
})

test('guidance is decided once per session; /render and a new session reset it', () => {
  const env: NodeJS.ProcessEnv = { AR_TERM_RENDER_IMAGES: '1' }
  const h = harness(env)
  const ask = () => h.fire('before_agent_start', { systemPrompt: 'SYS' })[0]
  const first = ask()
  assert.equal(first.systemPrompt, `SYS\n\n${GUIDANCE}`)
  env.AR_TERM_RENDER_IMAGES = '0' // graphics vanish mid-session
  assert.equal(h.renderer.available().ok, false)
  assert.deepEqual(ask(), first, 'same answer, byte for byte')

  h.command('render', 'off')
  assert.equal(ask(), undefined)
  env.AR_TERM_RENDER_IMAGES = '1'
  assert.equal(ask(), undefined, 'off sticks until changed')
  h.command('render', 'on')
  assert.equal(ask().systemPrompt, `SYS\n\n${GUIDANCE}`)

  env.AR_TERM_RENDER_IMAGES = '0'
  h.fire('session_start')
  assert.equal(ask(), undefined, 'a new session decides again')
  h.cleanup()
})

test('/render status, redraw and usage', () => {
  const h = harness({ AR_TERM_RENDER_IMAGES: '1' })
  h.command('render', 'status')
  h.command('render', 'redraw')
  h.command('render', 'wat')
  assert.match(h.notes[0]!, /^render: on; graphics yes/)
  assert.match(h.notes[1]!, /resent 0 image/)
  assert.match(h.notes[2]!, /usage/)
  h.cleanup()
})

test('session_start registers the widget that captures the TUI', () => {
  const h = harness({ AR_TERM_RENDER_IMAGES: '1' })
  h.fire('session_start')
  assert.deepEqual(h.widgets, ['ar-term-render'])
  h.cleanup()
})

test('a background-rendered figure asks the TUI to rebuild', { skip: hasRsvg ? false : 'rsvg missing' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'artr-ad-'))
  const handlers: Record<string, Handler[]> = {}
  let transformer!: (md: string, ctx: any) => string
  const api: any = {
    on: (e: string, h: Handler) => (handlers[e] ??= []).push(h),
    registerMarkdownTransformer: (fn: typeof transformer) => (transformer = fn),
    registerCommand: () => {},
  }
  const tui = { n: 0, invalidate() { this.n++ }, requestRender() {} }
  const ctx = { ui: { theme: { getBgAnsi: () => '' }, notify() {}, setWidget: (_k: string, f: (t: typeof tui) => unknown) => void f(tui) } }
  install(api, { env: { AR_TERM_RENDER_IMAGES: '1' }, rendererOptions: { budgetMs: -1, cacheDir: dir, run: () => null } })
  handlers.session_start![0]!({}, ctx)
  assert.match(transformer(SVG_MD, { messageType: 'assistant', isStreaming: false, availableWidth: 80 }), /\[figure: Box\]/)
  for (let i = 0; i < 100 && tui.n === 0; i++) await new Promise((r) => setTimeout(r, 20))
  assert.equal(tui.n, 1)
  rmSync(dir, { recursive: true, force: true })
})

test('watcher: waits on tmux, redraws after jitter, respawns; failures back off', () => {
  const h = harness({ AR_TERM_RENDER_IMAGES: '1', TMUX: '/tmp/x,1,0' })
  let redraws = 0
  h.renderer.redraw = () => (redraws++, 0)
  h.fire('session_start')
  assert.equal(h.spawned.length, 1)

  // A signal after a long wait: jittered redraw (0.5 * 2000 ms), then respawn now.
  h.setClock(5000)
  h.spawned[0]!.emit('exit', 0)
  const jitter = h.timers.find((t) => t.ms === 1000)!
  assert.ok(jitter)
  assert.equal(redraws, 0)
  jitter.fn()
  assert.equal(redraws, 1)
  const respawn = h.timers.at(-1)!
  assert.equal(respawn.ms, 0)
  respawn.fn()
  assert.equal(h.spawned.length, 2)

  // An instant exit is a failure: no spin, 10 s backoff.
  h.spawned[1]!.emit('exit', 0)
  assert.equal(h.timers.at(-1)!.ms, 10_000)
  h.timers.at(-1)!.fn()
  h.spawned[2]!.emit('exit', 1)
  assert.equal(h.timers.at(-1)!.ms, 10_000)
  h.cleanup()
})

test('watcher: shutdown kills the wait, cancels a pending redraw and never respawns', () => {
  const h = harness({ AR_TERM_RENDER_IMAGES: '1', TMUX: '/tmp/x,1,0' })
  let redraws = 0
  h.renderer.redraw = () => (redraws++, 0)
  h.fire('session_start')
  h.setClock(5000)
  h.spawned[0]!.emit('exit', 0)
  const pending = h.timers.find((t) => t.ms === 1000)!
  h.fire('session_shutdown')
  assert.equal(h.spawned[0]!.killed, true)
  assert.equal(pending.cancelled, true)
  const before = h.spawned.length
  h.spawned[0]!.emit('exit', 0) // the killed wait reports in
  h.timers.filter((t) => !t.cancelled).forEach((t) => t.fn())
  assert.equal(h.spawned.length, before)
  assert.equal(redraws, 0)
  h.cleanup()
})

test('no TMUX, no watcher', () => {
  const h = harness({ AR_TERM_RENDER_IMAGES: '1' })
  h.fire('session_start')
  assert.equal(h.spawned.length, 0)
  h.cleanup()
})
