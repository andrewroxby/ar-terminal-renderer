import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
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

test('math layout: 0.8 em per cell height, left aligned, shrinks only to fit', () => {
  const cell = { w: 9, h: 18 }
  const small = layoutMath(2500, 1250, 80, cell) // 2.5 em wide, 1.25 em tall
  assert.equal(small.fitW, 36)
  assert.equal(small.fitH, 18)
  assert.equal(small.left, 0)
  assert.equal(small.rows, 1)
  assert.equal(small.cols, 4)
  const wide = layoutMath(200_000, 1000, 40, cell)
  assert.equal(wide.cols, 38)
  assert.ok(wide.fitW <= 38 * 9)
})

// MathJax's macro maps are shared by the whole process, so a definition in
// one block must not reach the next. The commands that define things are
// absent, which leaves those blocks as text.
const PROBE = '\\pi + \\frac{1}{2} + \\sin x + \\operatorname{foo} \\alpha + \\abs{x} + {\\color{red} y}'

test('definition commands fail and leave no state behind', () => {
  const here = fileURLToPath(new URL('./math.ts', import.meta.url))
  const fresh = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `import { mathToSvg } from ${JSON.stringify(here)}; process.stdout.write(mathToSvg(${JSON.stringify(PROBE)}, '#ddd').svg)`],
    { encoding: 'utf8' },
  ).stdout
  assert.ok(fresh.startsWith('<svg'))
  assert.equal(mathToSvg(PROBE, '#ddd')!.svg, fresh)
  for (const tex of [
    '\\newcommand{\\pi}{HACKED}',
    '\\renewcommand{\\frac}{HACKED}',
    '\\def\\pi{HACKED}',
    '\\let\\pi\\alpha',
    '\\DeclareMathOperator{\\sin}{HACKED}',
    '\\DeclareMathOperator{\\foo}{FOO}\\foo',
    '\\DeclarePairedDelimiter{\\abs}{\\lvert}{\\rvert}',
    '\\newenvironment{foo}{a}{b}',
    '\\definecolor{red}{rgb}{0,0,1}',
    '\\newtagform{foo}{[}{]}',
    '\\mathtoolsset{showonlyrefs}',
    '\\text{\\newcommand{\\pi}{x}}',
    '\\newcommand{\\foo}{BAR} \\foo',
    '\\newcommand{\\frac}{x} \\frac{',
  ]) {
    assert.equal(mathToSvg(tex, '#ddd'), null, tex)
    assert.equal(mathToSvg(PROBE, '#ddd')!.svg, fresh, tex)
  }
  assert.equal(mathToSvg('\\foo', '#ddd'), null)
})

test('\\text{href} draws; converted svg over 300 KB is refused', () => {
  assert.ok(mathToSvg('\\text{href} = \\text{src}', '#ddd'))
  const terms = (n: number) => Array.from({ length: n }, (_v, i) => `x_{${i}}`).join('+')
  assert.ok(mathToSvg(terms(100), '#ddd'))
  assert.equal(mathToSvg(terms(150), '#ddd'), null)
})
