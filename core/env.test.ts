import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectGraphics, tmuxCell, type Run } from './env.ts'

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
