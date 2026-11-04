import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { detectGraphics, indentFromEnv, tmuxCell, type Run } from './env.ts'

const tmuxRun = (viewer: string | null, term = ''): Run => (_c, args) =>
  args.includes('@viewer') ? viewer : args.some((a) => a.includes('client_termname')) ? term : null

test('override wins', () => {
  assert.equal(detectGraphics({ AR_TERM_RENDER_IMAGES: '0', TMUX: 'x' }, tmuxRun('graphics=file')).ok, false)
  assert.equal(detectGraphics({ AR_TERM_RENDER_IMAGES: '1' }, tmuxRun(null)).ok, true)
})

test('under tmux the @viewer line decides', () => {
  const env = { TMUX: 'x' }
  assert.equal(detectGraphics(env, tmuxRun('transport=local device=a client=terminal graphics=file')).ok, true)
  assert.equal(detectGraphics(env, tmuxRun('transport=et device=a client=terminal graphics=inline')).ok, true)
  assert.equal(detectGraphics(env, tmuxRun('transport=mosh device=a client=terminal graphics=no')).ok, false)
  assert.equal(detectGraphics(env, tmuxRun('transport=none graphics=file')).ok, false)
})

test('under tmux without @viewer the client terminal decides', () => {
  assert.equal(detectGraphics({ TMUX: 'x' }, tmuxRun(null, 'xterm-ghostty')).ok, true)
  assert.equal(detectGraphics({ TMUX: 'x' }, tmuxRun(null, 'xterm-256color')).ok, false)
})

test('outside tmux Ghostty and kitty draw, others do not', () => {
  assert.equal(detectGraphics({ TERM_PROGRAM: 'ghostty' }, () => null).ok, true)
  assert.equal(detectGraphics({ KITTY_WINDOW_ID: '1' }, () => null).ok, true)
  assert.equal(detectGraphics({ TERM: 'xterm-256color', TERM_PROGRAM: 'Apple_Terminal' }, () => null).ok, false)
})

test('tmux cell size is used only when set', () => {
  assert.deepEqual(tmuxCell(() => '9 20'), { w: 9, h: 20 })
  assert.equal(tmuxCell(() => '0 0'), null)
  assert.equal(tmuxCell(() => null), null)
})

test('transport mode: file only for a local viewer, inline otherwise, env can force', () => {
  const t = { TMUX: 'x' }
  assert.equal(detectGraphics(t, tmuxRun('transport=local graphics=file')).mode, 'file')
  assert.equal(detectGraphics(t, tmuxRun('transport=et graphics=inline')).mode, 'inline')
  assert.equal(detectGraphics(t, tmuxRun(null, 'xterm-ghostty')).mode, 'inline')
  assert.equal(detectGraphics({ TERM_PROGRAM: 'ghostty' }, () => null).mode, 'inline')
  assert.equal(detectGraphics({ ...t, AR_TERM_RENDER_TRANSPORT: 'inline' }, tmuxRun('graphics=file')).mode, 'inline')
  assert.equal(detectGraphics({ ...t, AR_TERM_RENDER_TRANSPORT: 'file' }, tmuxRun('graphics=inline')).mode, 'file')
})

test('indents are integers 0-8, else the defaults: 2 for figures, 3 for math', () => {
  assert.deepEqual(indentFromEnv({}), { figure: 2, math: 3 })
  assert.equal(indentFromEnv({ AR_TERM_RENDER_INDENT: '3' }).figure, 3)
  assert.equal(indentFromEnv({ AR_TERM_RENDER_INDENT: '0' }).figure, 0)
  assert.equal(indentFromEnv({ AR_TERM_RENDER_MATH_INDENT: '8' }).math, 8)
  for (const bad of ['9', '-1', '2.5', 'x', '']) {
    assert.equal(indentFromEnv({ AR_TERM_RENDER_INDENT: bad }).figure, 2, bad)
    assert.equal(indentFromEnv({ AR_TERM_RENDER_MATH_INDENT: bad }).math, 3, bad)
  }
})

// The Neovim adapter reads the same file (nvim/tests/terminal_spec.lua), so
// the two detectors cannot drift apart.
interface Vector {
  name: string
  env: NodeJS.ProcessEnv
  viewer: string | null
  term: string | null
  ok: boolean
}

test('shared detection vectors', () => {
  const vectors = JSON.parse(readFileSync(new URL('./test/detect-vectors.json', import.meta.url), 'utf8')) as Vector[]
  assert.ok(vectors.length > 10)
  for (const v of vectors) {
    assert.equal(detectGraphics(v.env, tmuxRun(v.viewer, v.term ?? '')).ok, v.ok, v.name)
  }
})
