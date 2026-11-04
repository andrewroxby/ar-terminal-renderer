import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lookup, render, renderAsync, sweep, sweepDaily, CACHE_MAX_AGE_MS, type RasterOptions } from './raster.ts'
import { layout } from './layout.ts'

const hasRsvg = spawnSync('rsvg-convert', ['--version']).status === 0
const opts = { skip: hasRsvg ? false : 'rsvg-convert missing' }

const GOOD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><rect width="20" height="10" fill="#369"/></svg>'
const BAD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><rect></svg>'

function ro(svg: string, cacheDir: string): RasterOptions {
  return { svg, layout: layout(20, 10, 80, { w: 9, h: 18 }, 2), bg: '#1e1e2e', cacheDir }
}

test('render caches, lookup hits, and a failing svg is remembered as .fail', opts, () => {
  const dir = mkdtempSync(join(tmpdir(), 'artr-r-'))
  const good = ro(GOOD, dir)
  assert.equal(lookup(good).state, 'miss')
  const p = render(good)!
  assert.ok(p && existsSync(p))
  assert.deepEqual(lookup(good), { state: 'hit', path: p })

  const bad = ro(BAD, dir)
  assert.equal(render(bad), null)
  assert.equal(lookup(bad).state, 'fail')
  assert.ok(readdirSync(dir).some((f) => f.endsWith('.fail')))
  rmSync(dir, { recursive: true })
})

test('async render matches, and a missing rsvg-convert is not remembered', opts, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'artr-r-'))
  const p = await renderAsync(ro(GOOD, dir))
  assert.ok(p && existsSync(p))

  const other = ro(GOOD.replace('#369', '#963'), dir)
  const saved = process.env.PATH
  process.env.PATH = '/nonexistent'
  try {
    assert.equal(render(other), null)
    assert.equal(await renderAsync(other), null)
  } finally {
    process.env.PATH = saved
  }
  assert.equal(lookup(other).state, 'miss')
  rmSync(dir, { recursive: true })
})

test('stale .fail markers expire with the cache rule', () => {
  const dir = mkdtempSync(join(tmpdir(), 'artr-r-'))
  mkdirSync(dir, { recursive: true })
  const f = join(dir, 'x.fail')
  writeFileSync(f, '')
  const old = new Date(Date.now() - CACHE_MAX_AGE_MS - 1000)
  utimesSync(f, old, old)
  assert.equal(sweep(dir), 1)
  assert.ok(!existsSync(f))
  rmSync(dir, { recursive: true })
})

test('sweepDaily sweeps once, then not again until a day has passed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'artr-sd-'))
  const stale = (name: string) => {
    const f = join(dir, name)
    writeFileSync(f, 'x')
    const old = new Date(Date.now() - CACHE_MAX_AGE_MS - 1000)
    utimesSync(f, old, old)
    return f
  }
  const a = stale('a.png')
  assert.equal(sweepDaily(dir), 1)
  assert.ok(!existsSync(a))
  const b = stale('b.png')
  assert.equal(sweepDaily(dir), 0, 'the stamp is fresh')
  assert.ok(existsSync(b))
  assert.equal(sweepDaily(dir, Date.now() + 25 * 3600 * 1000), 1)
  assert.ok(!existsSync(b))
  rmSync(dir, { recursive: true })
})

// The sanitizer strips external references, but rsvg-convert is the second
// line of defence: fed on stdin from an empty directory it must not load
// files. This guards that assumption against librsvg changes.
test('rsvg on stdin refuses file://, absolute and relative image references', opts, () => {
  const dir = mkdtempSync(join(tmpdir(), 'artr-guard-'))
  const run = (svg: string, cwd = dir) =>
    spawnSync('rsvg-convert', ['-f', 'png', '-w', '40', '-h', '40'], { input: svg, cwd }).stdout as Buffer

  const red = run('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="red"/></svg>')
  writeFileSync(join(dir, 'red.png'), red)

  const wrap = (inner: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">${inner}</svg>`
  const blank = run(wrap(''))
  const dataUri = `data:image/png;base64,${red.toString('base64')}`

  // Control: an image rsvg may load changes the output.
  assert.notDeepEqual(run(wrap(`<image width="10" height="10" href="${dataUri}"/>`)), blank)

  for (const ref of [`file://${join(dir, 'red.png')}`, join(dir, 'red.png'), 'red.png', './red.png']) {
    assert.deepEqual(run(wrap(`<image width="10" height="10" href="${ref}"/>`)), blank, ref)
    assert.deepEqual(run(wrap(`<image width="10" height="10" xlink:href="${ref}"/>`)), blank, `xlink ${ref}`)
  }
  rmSync(dir, { recursive: true })
})

const hasMagick = spawnSync('magick', ['-version']).status === 0

// RGBA of one pixel, as "r,g,b,a" with 0-255 channels.
function pixel(png: string, x: number, y: number): string {
  const r = spawnSync('magick', [png, '-format', `%[fx:int(255*p{${x},${y}}.r)],%[fx:int(255*p{${x},${y}}.g)],%[fx:int(255*p{${x},${y}}.b)],%[fx:int(255*p{${x},${y}}.a)]`, 'info:'], { encoding: 'utf8' })
  return r.stdout.trim()
}

test('a card is drawn from the indent on, and the indent stays transparent', { skip: hasRsvg && hasMagick ? false : 'rsvg or magick missing' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'artr-r-'))
  const l = layout(20, 10, 80, { w: 9, h: 18 }, 2, 2)
  assert.equal(l.cardX, 18)
  const p = render({ svg: GOOD, layout: l, bg: '#1e1e2e', cacheDir: dir })!
  assert.equal(pixel(p, 0, 0), '0,0,0,0')
  assert.equal(pixel(p, 17, l.pxH - 1), '0,0,0,0')
  assert.equal(pixel(p, 18, 0), '30,30,46,255') // card color, first card column
  assert.equal(pixel(p, l.pxW - 1, l.pxH - 1), '30,30,46,255')
  const [r, g, b, a] = pixel(p, l.left + Math.floor(l.fitW / 2), l.top + Math.floor(l.fitH / 2)).split(',')
  assert.deepEqual([r, g, b, a], ['51', '102', '153', '255']) // the figure, #369
  // The same figure and card without the indent is another cache entry.
  const flush = ro(GOOD, dir)
  assert.notEqual(render(flush), p)
  rmSync(dir, { recursive: true })
})

test('a figure root with its own x, y, width and height still lands in its place', { skip: hasRsvg && hasMagick ? false : 'rsvg or magick missing' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'artr-r-'))
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" x="500" y="500" width="9" height="9" viewBox="0 0 20 10"><rect width="20" height="10" fill="#369"/></svg>'
  const l = layout(20, 10, 80, { w: 9, h: 18 }, 2, 2)
  const p = render({ svg, layout: l, bg: '#1e1e2e', cacheDir: dir })!
  assert.equal(pixel(p, l.left + 2, l.top + 2), '51,102,153,255')
  rmSync(dir, { recursive: true })
})

test('a caller-set limit cuts a slow sync render short without remembering a failure', opts, () => {
  const dir = mkdtempSync(join(tmpdir(), 'artr-r-'))
  const bin = mkdtempSync(join(tmpdir(), 'artr-bin-'))
  writeFileSync(join(bin, 'rsvg-convert'), '#!/bin/sh\nexec sleep 3\n', { mode: 0o755 })
  const saved = process.env.PATH
  process.env.PATH = `${bin}:/bin:/usr/bin`
  try {
    const o = ro(GOOD, dir)
    const t0 = Date.now()
    assert.equal(render(o, 150), 'slow')
    assert.ok(Date.now() - t0 < 1500)
    assert.equal(lookup(o).state, 'miss')
    assert.ok(!readdirSync(dir).some((f) => f.endsWith('.fail')))
  } finally {
    process.env.PATH = saved
    rmSync(dir, { recursive: true, force: true })
    rmSync(bin, { recursive: true, force: true })
  }
})
