import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLACEHOLDER } from './kitty.ts'

const hasRsvg = spawnSync('rsvg-convert', ['--version']).status === 0
const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url))

function demo(args: string[], env: Record<string, string>) {
  const tmp = mkdtempSync(join(tmpdir(), 'artr-demo-'))
  const clean = { ...process.env }
  for (const k of ['TMUX', 'TERM_PROGRAM', 'KITTY_WINDOW_ID', 'GHOSTTY_RESOURCES_DIR', 'AR_TERM_RENDER_IMAGES', 'AR_TERM_RENDER_INDENT']) delete clean[k]
  const r = spawnSync('node', [CLI, 'demo', ...args], { env: { ...clean, TMPDIR: tmp, ...env }, encoding: 'utf8', timeout: 60_000 })
  rmSync(tmp, { recursive: true, force: true })
  return r
}

test('demo with images off prints the fallback text and exits', () => {
  const r = demo([], { AR_TERM_RENDER_IMAGES: '0' })
  assert.equal(r.status, 0)
  assert.match(r.stdout, /^# Indent comparison/)
  assert.match(r.stdout, /\[figure: Binary search tree\]/)
  assert.match(r.stdout, /```mermaid\nflowchart LR/)
  assert.match(r.stdout, /```python/)
  assert.ok(!r.stdout.includes('\x1b_G'))
})

test('demo draws every block with images on: transmits come first, then rows', { skip: hasRsvg ? false : 'rsvg missing' }, () => {
  const r = demo([], { AR_TERM_RENDER_IMAGES: '1' })
  assert.equal(r.status, 0, r.stderr)
  const out = r.stdout
  assert.ok(!out.includes('```svg') && !out.includes('```mermaid') && !out.includes('$$') && !out.includes('\\['))
  assert.match(out, /```python/)
  const sends = out.split('\x1b_Ga=T').length - 1
  assert.equal(sends, 5) // svg, two mermaid diagrams, two math blocks
  assert.ok(out.lastIndexOf('\x1b_Ga=T') < out.indexOf(PLACEHOLDER))
})

test('demo takes a file and honors AR_TERM_RENDER_INDENT', { skip: hasRsvg ? false : 'rsvg missing' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'artr-demo-'))
  const f = join(dir, 'm.md')
  writeFileSync(f, 'Hi\n\n$$\nx^2\n$$\n')
  const cols = (indent: string): number => {
    const r = demo([f], { AR_TERM_RENDER_IMAGES: '1', AR_TERM_RENDER_INDENT: indent })
    assert.equal(r.status, 0, r.stderr)
    const row = r.stdout.split('\n').find((l) => l.includes(PLACEHOLDER))!
    return [...row].filter((c) => c === PLACEHOLDER).length
  }
  assert.equal(cols('3'), cols('0') + 3)
  rmSync(dir, { recursive: true, force: true })
})
