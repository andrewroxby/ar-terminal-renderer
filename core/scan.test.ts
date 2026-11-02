import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scan } from './scan.ts'

const LANGS = new Set(['svg'])

test('finds a closed svg fence with its body and span', () => {
  const md = 'intro\n```svg\n<svg/>\n```\nouter'
  const [b] = scan(md, LANGS)
  assert.equal(b!.kind, 'fence')
  assert.equal(b!.kind === 'fence' && b!.body, '<svg/>')
  assert.equal(md.slice(b!.start, b!.end), '```svg\n<svg/>\n```')
})

test('unclosed fence stays text', () => {
  assert.deepEqual(scan('a\n```svg\n<svg/>\n', LANGS), [])
})

test('svg fence nested inside another fence is skipped', () => {
  const md = '````markdown\n```svg\n<svg/>\n```\n````\n'
  assert.deepEqual(scan(md, LANGS), [])
})

test('shorter closer does not close a longer fence', () => {
  const md = '````svg\n<svg/>\n```\nstill inside\n````\n'
  const [b] = scan(md, LANGS)
  assert.equal(b!.kind === 'fence' && b!.body, '<svg/>\n```\nstill inside')
})

test('tilde fences and other languages', () => {
  const md = '~~~svg\n<svg/>\n~~~\n```js\nx\n```\n'
  const bs = scan(md, LANGS)
  assert.equal(bs.length, 1)
  assert.equal(bs[0]!.kind === 'fence' && bs[0]!.lang, 'svg')
})

test('standalone png image line', () => {
  const md = 'text\n![a plot](/tmp/p.png)\nmore'
  const [b] = scan(md, LANGS)
  assert.equal(b!.kind, 'image')
  assert.equal(b!.kind === 'image' && b!.path, '/tmp/p.png')
  assert.equal(b!.kind === 'image' && b!.alt, 'a plot')
  assert.equal(md.slice(b!.start, b!.end), '![a plot](/tmp/p.png)')
})

test('inline, relative and non-png images are ignored', () => {
  assert.deepEqual(scan('see ![x](/a.png) here', LANGS), [])
  assert.deepEqual(scan('![x](a.png)', LANGS), [])
  assert.deepEqual(scan('![x](/a.jpg)', LANGS), [])
})

test('image line inside a fence is ignored', () => {
  assert.deepEqual(scan('```\n![x](/a.png)\n```\n', LANGS), [])
})

test('empty body and CRLF', () => {
  assert.equal(scan('```svg\n```', LANGS)[0]!.kind === 'fence', true)
  const [b] = scan('```svg\r\n<svg/>\r\n```\r\n', LANGS)
  assert.equal(b!.kind === 'fence' && b!.body.trim(), '<svg/>')
})
