import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Renderer } from './render.ts'
import { PLACEHOLDER } from './kitty.ts'

const hasRsvg = spawnSync('rsvg-convert', ['--version']).status === 0
const opts = { skip: hasRsvg ? false : 'rsvg-convert missing' }

const SVG = (title: string) =>
  `<svg viewBox="0 0 200 100"><title>${title}</title><rect width="200" height="100" fill="#369"/></svg>`
const fence = (title: string) => '```svg\n' + SVG(title) + '\n```'

function setup(env: NodeJS.ProcessEnv = { AR_TERM_RENDER_IMAGES: '1' }) {
  const dir = mkdtempSync(join(tmpdir(), 'artr-test-'))
  const writes: string[] = []
  const r = new Renderer({
    write: (d) => writes.push(d),
    env,
    run: () => null,
    cacheDir: join(dir, 'cache'),
  })
  return { r, writes, dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

const rowsOf = (s: string) => s.split('\n').filter((l) => l.includes(PLACEHOLDER))

test('svg fence becomes placeholder rows, transmitted once, stable across rebuilds', opts, () => {
  const { r, writes, done } = setup()
  const md = `Before\n${fence('Box')}\nAfter`
  const a = r.transform(md, { width: 80 })
  assert.ok(!a.includes('<svg'))
  const rows = rowsOf(a)
  assert.ok(rows.length >= 2)
  assert.equal(writes.length, 1)
  assert.ok(writes[0]!.startsWith('\x1b_Ga=T,U=1,f=100,q=2,i='))
  assert.equal(r.transform(md, { width: 80 }), a)
  assert.equal(writes.length, 1)
  // Rows stay out of the neighboring paragraphs.
  const lines = a.split('\n')
  assert.equal(lines[0], 'Before')
  assert.equal(lines[1], '')
  assert.equal(lines.at(-2), '')
  assert.equal(lines.at(-1), 'After')
  done()
})

test('under tmux the transmit is wrapped', opts, () => {
  const { r, writes, done } = setup({ AR_TERM_RENDER_IMAGES: '1', TMUX: '/tmp/x,1,0' })
  r.transform(fence('Box'), { width: 80 })
  assert.ok(writes[0]!.startsWith('\x1bPtmux;\x1b\x1b_G'))
  done()
})

test('redraw resends known images', opts, () => {
  const { r, writes, done } = setup()
  r.transform(fence('Box'), { width: 80 })
  assert.equal(r.redraw(), 1)
  assert.equal(writes.length, 2)
  assert.equal(writes[0], writes[1])
  done()
})

test('cap: the fourth figure in a message falls back to text', opts, () => {
  const { r, done } = setup()
  const md = ['A', 'B', 'C', 'D'].map((t) => fence(t)).join('\n\n')
  const out = r.transform(md, { width: 80 })
  assert.match(out, /\[figure: D\]/)
  assert.doesNotMatch(out, /\[figure: [ABC]\]/)
  done()
})

test('no graphics: fallback text, nothing transmitted', () => {
  const { r, writes, done } = setup({ AR_TERM_RENDER_IMAGES: '0' })
  const out = r.transform(`x\n${fence('Flow chart')}\ny\n![the plot](/tmp/nope.png)`, { width: 80 })
  assert.equal(out, 'x\n\n[figure: Flow chart]\n\ny\n\n[image: the plot - /tmp/nope.png]')
  assert.equal(writes.length, 0)
  done()
})

test('/render off leaves the markdown untouched', () => {
  const { r, done } = setup()
  r.enabled = false
  const md = fence('Box')
  assert.equal(r.transform(md, { width: 80 }), md)
  done()
})

test('unclosed fence and fence-less text pass through', () => {
  const { r, done } = setup()
  const open = '```svg\n<svg viewBox="0 0 1 1">'
  assert.equal(r.transform(open, { width: 80 }), open)
  assert.equal(r.transform('plain text', { width: 80 }), 'plain text')
  done()
})

test('unrenderable svg falls back even when graphics are on', opts, () => {
  const { r, writes, done } = setup()
  assert.equal(r.transform('```svg\n<html/>\n```', { width: 80 }).trim(), '[figure]')
  assert.equal(writes.length, 0)
  done()
})

test('png line: drawn when the file is valid, text when missing', opts, () => {
  const { r, writes, dir, done } = setup()
  const png = join(dir, 'p.png')
  const made = spawnSync('rsvg-convert', ['-f', 'png', '-w', '60', '-h', '30'], { input: SVG('x') })
  writeFileSync(png, made.stdout)
  const out = r.transform(`![cap](${png})`, { width: 80 })
  assert.ok(rowsOf(out).length >= 1)
  assert.equal(writes.length, 1)
  assert.equal(r.transform('![cap](/nope/missing.png)', { width: 80 }).trim(), '[image: cap - /nope/missing.png]')
  writeFileSync(join(dir, 'bad.png'), 'not a png')
  assert.equal(r.transform(`![](${join(dir, 'bad.png')})`, { width: 80 }).trim(), `[image: ${join(dir, 'bad.png')}]`)
  done()
})

test('rendered PNG is cached on disk and reused by a second renderer', opts, () => {
  const { r, dir, done } = setup()
  r.transform(fence('Box'), { width: 80 })
  const cache = join(dir, 'cache')
  const before = readdirSync(cache).filter((f) => f.endsWith('.png'))
  assert.equal(before.length, 1)
  const r2 = new Renderer({ write: () => {}, env: { AR_TERM_RENDER_IMAGES: '1' }, run: () => null, cacheDir: cache })
  r2.transform(fence('Box'), { width: 80 })
  assert.deepEqual(readdirSync(cache).filter((f) => f.endsWith('.png')), before)
  done()
})
