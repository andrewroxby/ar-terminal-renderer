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

test('display math: $$ and \\[ blocks, single and multi line, own lines only', () => {
  const md = [
    'a',
    '$$x^2$$',
    'b',
    '$$',
    '\\frac{a}{b}',
    '$$',
    'c',
    '\\[ y = 1 \\]',
    'd',
    '\\[',
    'z',
    '\\]',
  ].join('\n')
  const bs = scan(md, LANGS).filter((b) => b.kind === 'math')
  assert.deepEqual(
    bs.map((b) => (b.kind === 'math' ? b.body.trim() : '')),
    ['x^2', '\\frac{a}{b}', 'y = 1', 'z'],
  )
  assert.equal(md.slice(bs[0]!.start, bs[0]!.end), '$$x^2$$')
  assert.equal(md.slice(bs[1]!.start, bs[1]!.end), '$$\n\\frac{a}{b}\n$$')
})

test('inline math, trailing text, blank lines, unclosed and fenced math are not blocks', () => {
  const none = (md: string) => assert.deepEqual(scan(md, LANGS).filter((b) => b.kind === 'math'), [], md)
  none('so $x^2$ here and $$y$$ inline')
  none('$$x$$ and then text')
  none('$$\na\n\nb\n$$')
  none('$$\nx')
  none('\\[ x')
  none('```\n$$\nx\n$$\n```')
  none('    $$\n    x\n    $$')
  none('price is $5 and $6')
})

test('math closes where Pi closes it: a backslash before the closer does not hide it', () => {
  const math = (md: string) => scan(md, LANGS).filter((b) => b.kind === 'math')
  const a = '$$a \\\\$$\ntext\n$$b$$'
  const bs = math(a)
  assert.equal(bs.length, 2)
  assert.equal(a.slice(bs[0]!.start, bs[0]!.end), '$$a \\\\$$')
  assert.equal(a.slice(bs[1]!.start, bs[1]!.end), '$$b$$')
  const c = '\\[ x \\\\]\nmore prose\n\\]'
  const cs = math(c)
  assert.equal(cs.length, 1)
  assert.equal(c.slice(cs[0]!.start, cs[0]!.end), '\\[ x \\\\]')
  // A closer that does not end its line is skipped, as in Pi.
  const d = '$$a$$ b\nc\n$$'
  assert.equal(d.slice(math(d)[0]!.start, math(d)[0]!.end), d)
  // A blank line right after the opener still disqualifies the block.
  assert.deepEqual(math('$$\n\nx\n$$'), [])
})

test('blocks carry the indentation of their first line', () => {
  const md = '- item\n  $$x^2$$\n  ```svg\n  <svg/>\n  ```\n  ![p](/a.png)\n$$y$$'
  assert.deepEqual(scan(md, LANGS).map((b) => [b.kind, b.indent]), [['math', '  '], ['fence', '  '], ['image', '  '], ['math', '']])
})
