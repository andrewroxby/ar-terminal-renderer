import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lookup, render, renderAsync, sweep, CACHE_MAX_AGE_MS, type RasterOptions } from './raster.ts'
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
