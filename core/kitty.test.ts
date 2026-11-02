import { test } from 'node:test'
import assert from 'node:assert/strict'
import { transmit, placeholderRows, wrapTmux, PLACEHOLDER, CHUNK } from './kitty.ts'
import { DIACRITICS } from './diacritics.ts'

const unwrap = (s: string) => s.slice('\x1bPtmux;'.length, -2).replaceAll('\x1b\x1b', '\x1b')

test('wrapTmux doubles every ESC inside the DCS envelope', () => {
  const w = wrapTmux('\x1b_Gx\x1b\\')
  assert.equal(w, '\x1bPtmux;\x1b\x1b_Gx\x1b\x1b\\\x1b\\')
  assert.equal(unwrap(w), '\x1b_Gx\x1b\\')
})

test('single chunk: control keys and m=0', () => {
  const [one, ...rest] = transmit(7, Buffer.from('hello'), 4, 2, false)
  assert.equal(rest.length, 0)
  assert.equal(one, `\x1b_Ga=T,U=1,f=100,q=2,i=7,c=4,r=2,m=0;${Buffer.from('hello').toString('base64')}\x1b\\`)
})

test('chunks are 4096 base64 bytes, only the first carries keys, last has m=0', () => {
  const png = Buffer.alloc(10000, 1)
  const b64 = png.toString('base64')
  const out = transmit(9, png, 10, 5, false)
  assert.equal(out.length, Math.ceil(b64.length / CHUNK))
  const parts = out.map((s) => /^\x1b_G([^;]*);([^\x1b]*)\x1b\\$/.exec(s)!)
  assert.ok(parts.every(Boolean))
  assert.match(parts[0]![1]!, /^a=T,U=1,f=100,q=2,i=9,c=10,r=5,m=1$/)
  assert.match(parts[1]![1]!, /^q=2,m=1$/)
  assert.match(parts.at(-1)![1]!, /^q=2,m=0$/)
  assert.ok(parts.slice(0, -1).every((p) => p[2]!.length === CHUNK))
  assert.equal(parts.map((p) => p[2]).join(''), b64)
})

test('under tmux every chunk is wrapped, and unwrapping restores the plain APC', () => {
  const png = Buffer.alloc(9000, 2)
  const plain = transmit(3, png, 6, 3, false)
  const wrapped = transmit(3, png, 6, 3, true)
  assert.equal(wrapped.length, plain.length)
  wrapped.forEach((w, i) => {
    assert.ok(w.startsWith('\x1bPtmux;\x1b\x1b_G') && w.endsWith('\x1b\x1b\\\x1b\\'))
    assert.equal(unwrap(w), plain[i])
  })
  // No bare APC anywhere: every \e_G is preceded by the doubled ESC.
  assert.ok(wrapped.every((w) => !/(^|[^\x1b])\x1b_G/.test(w.replaceAll('\x1b\x1b', '\x00\x00'))))
})

test('placeholder rows: one per row, cols cells each, id in the fg color', () => {
  const id = 0x0a0b0c
  const rows = placeholderRows(id, 3, 2)
  assert.equal(rows.length, 2)
  rows.forEach((row, r) => {
    assert.ok(row.startsWith('\x1b[38;2;10;11;12m') && row.endsWith('\x1b[39m'))
    const body = row.slice('\x1b[38;2;10;11;12m'.length, -'\x1b[39m'.length)
    assert.equal(body, [0, 1, 2].map((c) => PLACEHOLDER + DIACRITICS[r] + DIACRITICS[c]).join(''))
  })
})

test('too large a grid yields no rows', () => {
  assert.deepEqual(placeholderRows(1, DIACRITICS.length + 1, 1), [])
})
