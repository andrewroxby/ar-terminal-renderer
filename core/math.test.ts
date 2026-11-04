import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mathToSvg, normalizeTex } from './math.ts'
import { layoutMath as layoutMathOrNull, type Cell } from './layout.ts'
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

const layoutMath = (vw: number, vh: number, width: number, cell: Cell, indent = 0) => layoutMathOrNull(vw, vh, width, cell, indent)!

test('math layout: 0.8 em per cell height, indented, shrinks only to fit', () => {
  const cell = { w: 9, h: 18 }
  const small = layoutMath(2500, 1250, 80, cell, 2) // 2.5 em wide, 1.25 em tall
  assert.equal(small.fitW, 36)
  assert.equal(small.fitH, 18)
  assert.equal(small.left, 18)
  assert.equal(small.rows, 1)
  assert.equal(small.cols, 6)
  assert.equal(layoutMath(2500, 1250, 80, cell, 3).left, 27)
  assert.equal(layoutMath(2500, 1250, 80, cell).left, 0)
})

test('math that would shrink under the indent sits flush left at full width', () => {
  const cell = { w: 9, h: 18 }
  // Too wide for 40 columns: indenting would shrink it.
  const flush = layoutMath(30_000, 1000, 40, cell, 2)
  assert.equal(flush.left, 0)
  assert.equal(flush.cols, 38)
  assert.equal(flush.fitW, 38 * 9)
  // A wider formula in 190 columns is capped at 100 columns either way, so it is indented.
  const roomy = layoutMath(70_000, 1000, 190, cell, 2)
  assert.equal(roomy.left, 18)
  assert.equal(roomy.cols, 102)
  assert.equal(roomy.fitW, 100 * 9)
  // A formula that fits after the indent keeps it, one that fits only without drops it.
  assert.equal(layoutMath(22_000, 1000, 40, cell, 2).left, 18) // 317 px, room for 324
  assert.equal(layoutMath(23_000, 1000, 40, cell, 2).left, 0) // 331 px, fits flush (342) but not indented
  assert.equal(layoutMath(2500, 1250, 10, cell, 2).left, 18) // a small formula fits even in a narrow pane
})

test('math that would shrink below 0.5 em per cell height is refused', () => {
  const cell = { w: 9, h: 18 }
  // 38 columns is 342 px, which holds 38 em at the floor (9 px per em).
  assert.ok(layoutMathOrNull(37_000, 1000, 40, cell, 2))
  assert.equal(layoutMathOrNull(39_000, 1000, 40, cell, 2), null)
  assert.equal(layoutMathOrNull(200_000, 1000, 190, cell, 2), null)
  // Too tall for 30 rows at the floor.
  assert.equal(layoutMathOrNull(1000, 70_000, 80, cell, 2), null)
  // Dropping the indent can bring a formula back above the floor.
  assert.equal(layoutMathOrNull(37_500, 1000, 40, cell, 2)!.left, 0)
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

test('with a cache directory, a conversion is stored and read back, refusals too', () => {
  const dir = mkdtempSync(join(tmpdir(), 'artr-m-'))
  const a = mathToSvg('\\frac{a}{b} + c^2', '#abcdef', true, dir)!
  assert.ok(a)
  const files = readdirSync(dir)
  assert.equal(files.filter((f) => /^s-.*\.json$/.test(f)).length, 1)
  assert.deepEqual(mathToSvg('\\frac{a}{b} + c^2', '#abcdef', true, dir), a)
  // Display and inline, and each colour, are separate conversions.
  const inline = mathToSvg('\\frac{a}{b} + c^2', '#abcdef', false, dir)!
  assert.notEqual(inline.svg, a.svg)
  assert.notDeepEqual(mathToSvg('\\frac{a}{b} + c^2', '#123456', true, dir), a)
  assert.equal(readdirSync(dir).filter((f) => f.startsWith('s-')).length, 3)

  assert.equal(mathToSvg('\\frac{1}{', '#abcdef', true, dir), null)
  assert.ok(readdirSync(dir).some((f) => f.startsWith('m-') && f.endsWith('.fail')))
  assert.equal(mathToSvg('\\frac{1}{', '#abcdef', true, dir), null)
  rmSync(dir, { recursive: true, force: true })
})

test('a cached conversion needs no MathJax', () => {
  const dir = mkdtempSync(join(tmpdir(), 'artr-m-'))
  const script = (): string => {
    const r = spawnSync(process.execPath, ['-e', `
      const { mathToSvg } = await import(${JSON.stringify(fileURLToPath(new URL('./math.ts', import.meta.url)))})
      const t = performance.now()
      const m = mathToSvg('x^2+y^2', '#ffffff', true, ${JSON.stringify(dir)})
      console.log(JSON.stringify({ ok: !!m, ms: performance.now() - t }))
    `, '--input-type=module'], { encoding: 'utf8' })
    return r.stdout.trim()
  }
  const cold = JSON.parse(script())
  const warm = JSON.parse(script())
  assert.ok(cold.ok && warm.ok)
  assert.ok(warm.ms < cold.ms / 3, `cached ${warm.ms} ms vs ${cold.ms} ms`)
  rmSync(dir, { recursive: true, force: true })
})
