import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mathToSvg, normalizeTex } from './math.ts'
import { layoutMath } from './layout.ts'
import { MATH_CASES, BAD_MATH } from './test/math-cases.ts'

const hasRsvg = spawnSync('rsvg-convert', ['--version']).status === 0

test('every common display expression renders to a sized svg', () => {
  const failed: string[] = []
  for (const [name, tex] of Object.entries(MATH_CASES)) {
    const m = mathToSvg(tex, '#dddddd')
    if (!m || !/^<svg color="#dddddd"/.test(m.svg) || !(m.vw > 0 && m.vh > 0)) failed.push(name)
  }
  assert.deepEqual(failed, [])
  assert.ok(Object.keys(MATH_CASES).length >= 30)
})

test('every one of them survives rsvg-convert', { skip: hasRsvg ? false : 'rsvg missing' }, () => {
  const failed = Object.entries(MATH_CASES).filter(([, tex]) => {
    const m = mathToSvg(tex, '#dddddd')!
    return spawnSync('rsvg-convert', ['-f', 'png', '-w', '80'], { input: m.svg }).status !== 0
  })
  assert.deepEqual(failed.map(([k]) => k), [])
})

test('bad TeX and \\require are refused', () => {
  for (const tex of BAD_MATH) assert.equal(mathToSvg(tex, '#ddd'), null, tex)
  assert.equal(mathToSvg('   ', '#ddd'), null)
  assert.equal(mathToSvg('x'.repeat(9000), '#ddd'), null)
})

test('output is self-contained: no external references', () => {
  const m = mathToSvg(MATH_CASES.physics!, '#ddd')!
  assert.doesNotMatch(m.svg, /href|<image|@import|url\(\s*[^#)]/i)
})

test('\\tag becomes trailing text', () => {
  assert.equal(normalizeTex('a=b \\tag{1}'), 'a=b \\qquad\\text{(1)}')
  assert.equal(normalizeTex('a \\tag*{N}'), 'a \\qquad\\text{N}')
  assert.equal(normalizeTex('  a  '), 'a')
})

test('math layout: one em per cell height, left aligned, shrinks only to fit', () => {
  const cell = { w: 9, h: 18 }
  const small = layoutMath(2000, 1000, 80, cell) // 2 em wide, 1 em tall
  assert.equal(small.fitW, 36)
  assert.equal(small.fitH, 18)
  assert.equal(small.left, 0)
  assert.equal(small.rows, 1)
  assert.equal(small.cols, 4)
  const wide = layoutMath(200_000, 1000, 40, cell)
  assert.equal(wide.cols, 38)
  assert.ok(wide.fitW <= 38 * 9)
})
