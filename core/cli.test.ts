import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { MATH_EM, layoutMath } from './layout.ts'
import { DEFAULT_MATH } from './color.ts'
import { mathToSvg } from './math.ts'

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url))
const hasRsvg = spawnSync('rsvg-convert', ['--version']).status === 0
const opts = { skip: hasRsvg ? false : 'rsvg-convert missing' }

const tmp = mkdtempSync(join(tmpdir(), 'artr-cli-'))
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }))

function cli(args: string[], input = '') {
  return spawnSync(process.execPath, [CLI, ...args], {
    input,
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: tmp },
  })
}

function png(path: string): { w: number; h: number; colorType: number } {
  const b = readFileSync(path)
  assert.equal(b.toString('latin1', 1, 4), 'PNG')
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), colorType: b[25]! }
}

test('tex writes a transparent PNG and prints its path', opts, () => {
  const r = cli(['tex', '\\frac{a+b}{2}+x^2'])
  assert.equal(r.status, 0, r.stderr)
  const path = r.stdout.trim()
  assert.ok(path.startsWith(tmp) && path.endsWith('.png') && existsSync(path))
  const p = png(path)
  assert.equal(p.colorType, 6, 'RGBA, so the background is transparent')
  assert.ok(p.w > 0 && p.h > 0)
  assert.equal(cli(['tex', '\\frac{a+b}{2}+x^2']).stdout.trim(), path, 'same arguments, same cached file')
})

test('the default color is the one Pi draws math in', opts, () => {
  const a = cli(['tex', 'x^2']).stdout.trim()
  assert.equal(cli(['tex', '--color', DEFAULT_MATH, 'x^2']).stdout.trim(), a)
  assert.notEqual(cli(['tex', '--color', '#123456', 'x^2']).stdout.trim(), a)
})

test('--em-px scales the image, 64 by default; --padding adds logical pixels at --scale', opts, () => {
  const w = (args: string[]) => png(cli(['tex', '-p', '0', ...args, '\\frac{a+b}{2}+x^2']).stdout.trim()).w
  const base = w([])
  assert.equal(base, w(['--em-px', '64']))
  assert.ok(Math.abs(w(['--em-px', '128']) / base - 2) < 0.05)
  assert.equal(w(['--scale', '1']), base, '--scale does not size the formula')
  assert.equal(png(cli(['tex', '-p', '4', '--em-px', '64', '\\frac{a+b}{2}+x^2']).stdout.trim()).w, base + 16)
})

test('--em-px sets one em in pixels, as Pi sets display math (0.8 of the cell height)', opts, () => {
  const tex = '\\frac{a+b}{2}+x^2'
  const svg = mathToSvg(tex, '#cdd6f4', true)!
  const cell = { w: 24, h: 48 }
  const want = layoutMath(svg.vw, svg.vh, 200, cell, 0)!
  const r = cli(['tex', '--display', '-p', '0', '--em-px', String(cell.h * MATH_EM), tex])
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual([png(r.stdout.trim()).w, png(r.stdout.trim()).h], [want.fitW, want.fitH])
})

test('--cell pads the PNG to whole cells with the formula at the left', opts, () => {
  const tex = '\\frac{a+b}{2}+x^2'
  const flush = png(cli(['tex', '--display', '-p', '0', '--em-px', '38.4', tex]).stdout.trim())
  const r = cli(['tex', '--display', '-p', '0', '--em-px', '38.4', '--cell', '24x48', tex])
  assert.equal(r.status, 0, r.stderr)
  const p = png(r.stdout.trim())
  assert.deepEqual([p.w, p.h], [Math.ceil(flush.w / 24) * 24, Math.ceil(flush.h / 48) * 48])
})

test('-o writes the file and prints that path; --background fills it', opts, () => {
  const out = join(tmp, 'o.png')
  const r = cli(['tex', '-o', out, '--background', '#102030', 'x^2'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), out)
  assert.equal(png(out).colorType, 2, 'RGB, opaque')
})

test('--inline typesets limits beside the sum, --display above it', opts, () => {
  const w = (flag: string) => png(cli(['tex', flag, '\\sum_{i=1}^{n} x_i']).stdout.trim())
  assert.notDeepEqual(w('--inline'), w('--display'))
  assert.ok(w('--inline').w > w('--display').w)
})

test('LaTeX can come from stdin', opts, () => {
  const r = cli(['tex'], 'e^{i\\pi}+1=0\n')
  assert.equal(r.status, 0, r.stderr)
  assert.ok(existsSync(r.stdout.trim()))
})

test('failures exit non-zero with a short stderr message and no stdout', opts, () => {
  const bad = cli(['tex', '\\frac{1}{'])
  assert.equal(bad.status, 1)
  assert.equal(bad.stdout, '')
  assert.match(bad.stderr, /^ar-term-render: could not typeset/)
  assert.equal(cli(['tex', '--em-px', '50000', 'x']).status, 1)
  assert.equal(cli(['svg'], 'not svg').status, 1)
  assert.equal(cli(['mermaid'], 'pie title x\n "a": 1').status, 1)
})

test('usage errors exit 2', () => {
  for (const args of [[], ['wat'], ['tex'], ['tex', '--color', 'red', 'x'], ['tex', '--scale', '0', 'x'], ['tex', '--display', '--inline', 'x'], ['tex', '--size', '8', 'x'], ['tex', '--em-px', '0', 'x'], ['tex', '--cell', '24', 'x']]) {
    const r = cli(args)
    assert.equal(r.status, 2, args.join(' '))
    assert.match(r.stderr, /usage:/)
  }
  assert.equal(cli(['--help']).status, 0)
})

test('svg and mermaid read stdin and draw PNGs', opts, () => {
  const svg = cli(['svg', '--scale', '1'], '<svg viewBox="0 0 40 20"><rect width="40" height="20" fill="red"/></svg>')
  assert.equal(svg.status, 0, svg.stderr)
  assert.deepEqual([png(svg.stdout.trim()).w, png(svg.stdout.trim()).h], [40, 20])

  const mm = cli(['mermaid'], 'graph TD\n A[Start] --> B[End]')
  assert.equal(mm.status, 0, mm.stderr)
  const p = png(mm.stdout.trim())
  assert.equal(p.colorType, 2, 'drawn on the card')
  assert.ok(p.h > p.w * 0.5)
})
