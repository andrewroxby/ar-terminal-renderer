// Real tmux, private server (-L artr-test, never the default one): the
// wrapped APC must reach the outer client, a bare APC must not, and
// placeholder cells must survive.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transmit, placeholderRows, PLACEHOLDER } from './kitty.ts'
import { DIACRITICS } from './diacritics.ts'

const SOCKET = 'artr-test'
const HARNESS = join(dirname(fileURLToPath(import.meta.url)), 'test', 'tmux-capture.py')
const can = spawnSync('tmux', ['-V']).status === 0 && spawnSync('python3', ['--version']).status === 0

const ID = 0x123456
const RAW_ID = 0x654321

function run(mode: 'on' | 'all', hidden: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'artr-tmux-'))
  try {
    const png = Buffer.alloc(5000, 7) // two 4096-byte chunks
    const payload = [
      ...transmit(ID, png, 3, 2, true),
      // A bare APC, which tmux must not forward.
      `\x1b_Ga=T,U=1,f=100,q=2,i=${RAW_ID};AAAA\x1b\\`,
      ...placeholderRows(ID, 3, 2).map((l) => l + '\r\n'),
    ].join('')
    const file = join(dir, 'payload')
    writeFileSync(file, payload)
    const r = spawnSync('python3', [HARNESS, SOCKET, mode, hidden ? '1' : '0', file], {
      encoding: 'utf8',
      timeout: 20000,
    })
    assert.equal(r.status, 0, r.stderr)
    return Buffer.from(r.stdout, 'base64').toString('latin1')
  } finally {
    spawnSync('tmux', ['-L', SOCKET, 'kill-server'])
    rmSync(dir, { recursive: true, force: true })
  }
}

// tmux re-encodes UTF-8 for the client, so decode before searching cells.
const utf8 = (latin1: string) => Buffer.from(latin1, 'latin1').toString('utf8')

test('allow-passthrough all: wrapped APC arrives unwrapped, bare APC does not, cells survive', { skip: can ? false : 'tmux/python3 missing' }, () => {
  const out = run('all', false)
  const text = utf8(out)
  assert.ok(text.includes(`\x1b_Ga=T,U=1,f=100,q=2,i=${ID},c=3,r=2,m=1;`), 'first chunk reached the client')
  assert.ok(text.includes('\x1b_Gq=2,m=0;'), 'last chunk reached the client')
  assert.ok(!text.includes('\x1bPtmux;'), 'envelope was consumed by tmux')
  assert.ok(!text.includes(`i=${RAW_ID}`), 'bare APC was not forwarded')
  assert.ok(text.includes('38;2;18;52;86'), 'id color on the cells')
  assert.ok(text.includes(PLACEHOLDER + DIACRITICS[0] + DIACRITICS[0]), 'row 0 col 0 cell')
  assert.ok(text.includes(PLACEHOLDER + DIACRITICS[1] + DIACRITICS[2]), 'row 1 col 2 cell')
})

test('hidden window: dropped under allow-passthrough on, delivered under all', { skip: can ? false : 'tmux/python3 missing' }, () => {
  const on = utf8(run('on', true))
  const all = utf8(run('all', true))
  assert.ok(!on.includes(`i=${ID}`), 'on drops a hidden-window transmit')
  assert.ok(all.includes(`i=${ID}`), 'all delivers it')
})
