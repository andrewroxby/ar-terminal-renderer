import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Renderer, type Options } from './render.ts'
import { PLACEHOLDER } from './kitty.ts'

const hasRsvg = spawnSync('rsvg-convert', ['--version']).status === 0
const opts = { skip: hasRsvg ? false : 'rsvg-convert missing' }

const SVG = (title: string) =>
  `<svg viewBox="0 0 200 100"><title>${title}</title><rect width="200" height="100" fill="#369"/></svg>`
const fence = (title: string) => '```svg\n' + SVG(title) + '\n```'

function setup(env: NodeJS.ProcessEnv = { AR_TERM_RENDER_IMAGES: '1' }, extra: Partial<Options> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'artr-test-'))
  const writes: string[] = []
  const r = new Renderer({
    write: (d) => writes.push(d),
    env,
    run: () => null,
    cacheDir: join(dir, 'cache'),
    ...extra,
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const viewer = (graphics: string) => (_c: string, args: string[]) =>
  args.includes('@viewer') ? `transport=local device=a client=terminal graphics=${graphics}` : null

test('width changes that keep the layout reuse the id and send nothing', opts, () => {
  const { r, writes, done } = setup()
  const md = fence('Box')
  const a = r.transform(md, { width: 80 })
  const b = r.transform(md, { width: 120 })
  assert.equal(a, b)
  assert.equal(writes.length, 1)
  assert.equal(r.status().images, 1)
  // A width that changes the layout is a different image.
  r.transform(md, { width: 20 })
  assert.equal(writes.length, 2)
  assert.equal(r.status().images, 2)
  done()
})

test('graphics=file transmits one t=f escape with the cached path; inline chunks', opts, () => {
  const file = setup({ TMUX: 'x' }, { run: viewer('file') })
  file.r.transform(fence('Box'), { width: 80 })
  assert.equal(file.writes.length, 1)
  const m = /^\x1bPtmux;\x1b\x1b_Ga=T,U=1,f=100,t=f,q=2,i=\d+,c=\d+,r=\d+;([^\x1b]*)\x1b\x1b\\\x1b\\$/.exec(file.writes[0]!)
  assert.ok(m, 'single wrapped t=f escape')
  const path = Buffer.from(m![1]!, 'base64').toString()
  assert.ok(path.startsWith(join(file.dir, 'cache')) && path.endsWith('.png'))
  file.done()

  const inline = setup({ TMUX: 'x' }, { run: viewer('inline') })
  inline.r.transform(fence('Box'), { width: 80 })
  assert.match(inline.writes[0]!, /a=T,U=1,f=100,q=2,/)
  assert.doesNotMatch(inline.writes[0]!, /t=f/)
  inline.done()

  const forced = setup({ TMUX: 'x', AR_TERM_RENDER_TRANSPORT: 'inline' }, { run: viewer('file') })
  forced.r.transform(fence('Box'), { width: 80 })
  assert.doesNotMatch(forced.writes[0]!, /t=f/)
  forced.done()
})

test('inline transmit defers while another process holds the lock, then sends', opts, async () => {
  const { r, writes, dir, done } = setup({ AR_TERM_RENDER_IMAGES: '1' }, { lockWaitMs: 20, retryMs: 20 })
  const lock = join(dir, 'cache', 'transmit.lock')
  mkdirSync(lock, { recursive: true })
  const out = r.transform(fence('Box'), { width: 80 })
  assert.ok(rowsOf(out).length > 0, 'placeholders are drawn at once')
  assert.equal(writes.length, 0)
  rmSync(lock, { recursive: true })
  await sleep(400)
  assert.equal(writes.length, 1)
  r.forget()
  done()
})

test('a stale lock does not hold up a transmit', opts, () => {
  const { r, writes, dir, done } = setup({ AR_TERM_RENDER_IMAGES: '1' })
  const lock = join(dir, 'cache', 'transmit.lock')
  mkdirSync(lock, { recursive: true })
  const old = new Date(Date.now() - 10_000)
  utimesSync(lock, old, old)
  r.transform(fence('Box'), { width: 80 })
  assert.equal(writes.length, 1)
  done()
})

test('past the raster budget a figure shows its fallback, renders in the background, then draws', opts, async () => {
  let ready!: () => void
  const wait = new Promise<void>((res) => (ready = res))
  const { r, writes, done } = setup({ AR_TERM_RENDER_IMAGES: '1' }, { budgetMs: -1, onReady: () => ready() })
  const md = fence('Box')
  assert.equal(r.transform(md, { width: 80 }).trim(), '[figure: Box]')
  assert.equal(writes.length, 0)
  await wait
  assert.ok(rowsOf(r.transform(md, { width: 80 })).length > 0)
  assert.equal(writes.length, 1)
  done()
})

test('an svg rsvg rejects falls back and leaves a .fail marker', opts, () => {
  const { r, dir, done } = setup()
  const out = r.transform('```svg\n<svg viewBox="0 0 9 9"><title>Bad</title><rect></svg>\n```', { width: 80 })
  assert.equal(out.trim(), '[figure: Bad]')
  assert.ok(readdirSync(join(dir, 'cache')).some((f) => f.endsWith('.fail')))
  done()
})

function pngWith(w: number, h: number): Buffer {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12)
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  return b
}

test('a PNG that would decode past 16M pixels, a fifo and a directory are refused', opts, () => {
  const { r, dir, done } = setup()
  const bomb = join(dir, 'bomb.png')
  writeFileSync(bomb, pngWith(5000, 5000))
  assert.equal(r.transform(`![](${bomb})`, { width: 80 }).trim(), `[image: ${bomb}]`)

  const fifo = join(dir, 'pipe.png')
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0)
  assert.equal(r.transform(`![f](${fifo})`, { width: 80 }).trim(), `[image: f - ${fifo}]`)

  const d = join(dir, 'dir.png')
  mkdirSync(d)
  assert.equal(r.transform(`![d](${d})`, { width: 80 }).trim(), `[image: d - ${d}]`)
  done()
})

// Pi's real Markdown component must keep one placeholder row per line, with
// the id color, and count each cell as one column.
const PI_TUI = process.env.PI_TUI_PATH ?? '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js'
test('pi-tui Markdown keeps placeholder rows intact', { skip: hasRsvg && existsSync(PI_TUI) ? false : 'rsvg or pi-tui missing' }, async () => {
  const { Markdown, visibleWidth } = await import(PI_TUI)
  const { r, done } = setup()
  const out = r.transform(`Intro\n${fence('Box')}\nOutro`, { width: 78 })
  const rows = rowsOf(out)
  const identity = (x: string) => x
  const theme = new Proxy({}, { get: () => identity })
  const lines: string[] = new Markdown(out.trim(), 1, 0, theme, undefined, {}).render(80)
  const drawn = lines.filter((l) => l.includes(PLACEHOLDER))
  assert.equal(drawn.length, rows.length)
  const cols = [...rows[0]!.matchAll(new RegExp(PLACEHOLDER, 'g'))].length
  for (const l of drawn) {
    assert.match(l, /\x1b\[38;2;\d+;\d+;\d+m/)
    assert.equal([...l.matchAll(new RegExp(PLACEHOLDER, 'g'))].length, cols)
    assert.equal(visibleWidth(l), 80)
  }
  assert.ok(lines.some((l) => l.includes('Intro')) && lines.some((l) => l.includes('Outro')))
  done()
})

const MATH = (tex: string) => `$$\n${tex}\n$$`
const FLOW = '```mermaid\ngraph TD\n A[Start] --> B[End]\n```'

test('display math becomes rows with no card; the $$ text is gone', opts, () => {
  const { r, writes, done } = setup()
  const md = `Before\n${MATH('x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}')}\nAfter`
  const out = r.transform(md, { width: 80 })
  assert.ok(!out.includes('$$'))
  assert.ok(rowsOf(out).length >= 1)
  assert.equal(writes.length, 1)
  assert.equal(r.transform(md, { width: 80 }), out)
  assert.equal(writes.length, 1)
  const lines = out.split('\n')
  assert.equal(lines[0], 'Before')
  assert.equal(lines.at(-1), 'After')
  done()
})

test('math: inline $..$, code fences and unrenderable TeX are left exactly as written', opts, () => {
  const { r, writes, done } = setup()
  for (const md of [
    'inline $x^2$ stays, and so does $$y$$ inline',
    '```\n$$\nx\n$$\n```',
    MATH('\\frac{1}{'),
    MATH('\\foo{x}'),
    '$$\nunclosed',
  ]) {
    assert.equal(r.transform(md, { width: 80 }), md, md)
  }
  assert.equal(writes.length, 0)
  done()
})

test('math and mermaid are left untouched (not [figure]) when graphics are off', () => {
  const { r, writes, done } = setup({ AR_TERM_RENDER_IMAGES: '0' })
  const md = `${MATH('a=b')}\n\n${FLOW}\n\n\`\`\`svg\n<svg viewBox="0 0 1 1"><title>T</title></svg>\n\`\`\``
  const out = r.transform(md, { width: 80 })
  assert.ok(out.startsWith(`${MATH('a=b')}\n\n${FLOW}\n\n`))
  assert.ok(out.endsWith('[figure: T]'))
  assert.equal(writes.length, 0)
  done()
})

test('mermaid fence is drawn on the card; unsupported diagrams are left for Pi', opts, () => {
  const { r, writes, done } = setup()
  const out = r.transform(`x\n${FLOW}\ny`, { width: 80 })
  assert.ok(!out.includes('mermaid'))
  assert.ok(rowsOf(out).length >= 2)
  assert.equal(writes.length, 1)
  const pie = '```mermaid\npie title Pets\n "Dogs" : 5\n```'
  assert.equal(r.transform(pie, { width: 80 }), pie)
  done()
})

test('math has its own cap (12), separate from the 3 figures', opts, () => {
  const { r, done } = setup()
  const eqs = Array.from({ length: 14 }, (_v, i) => MATH(`x_{${i}} = ${i}`)).join('\n\n')
  const out = r.transform(eqs, { width: 80 })
  assert.equal(out.match(/x_\{\d+\}/g)!.length, 2, 'two blocks past the cap stay as text')
  const mixed = r.transform(`${fence('A')}\n\n${fence('B')}\n\n${fence('C')}\n\n${fence('D')}\n\n${MATH('a=b')}`, { width: 80 })
  assert.match(mixed, /\[figure: D\]/)
  assert.ok(!mixed.includes('$$'))
  done()
})

test('past the budget math waits, is left as text, then draws in the background', opts, async () => {
  let ready!: () => void
  const wait = new Promise<void>((res) => (ready = res))
  const { r, writes, done } = setup({ AR_TERM_RENDER_IMAGES: '1' }, { budgetMs: -1, onReady: () => ready() })
  const md = MATH('a = b + c')
  assert.equal(r.transform(md, { width: 80 }), md)
  await wait
  const out = r.transform(md, { width: 80 })
  assert.ok(rowsOf(out).length >= 1 && !out.includes('$$'))
  assert.equal(writes.length, 1)
  done()
})

// Pi's Markdown must see only plain rows where math was, with or without
// cellmath's patch on top.
test('pi-tui Markdown, with and without cellmath, shows just the rows for drawn math', { skip: hasRsvg && existsSync(PI_TUI) ? false : 'rsvg or pi-tui missing' }, async () => {
  const { Markdown } = await import(PI_TUI)
  const { r, done } = setup()
  const out = r.transform(`Intro\n${MATH('\\sum_{i=1}^n i = \\frac{n(n+1)}{2}')}\nOutro`, { width: 78 })
  const theme = new Proxy({}, { get: () => (x: string) => x })
  const render = () => new Markdown(out.trim(), 1, 0, theme, undefined, {}).render(80) as string[]
  const plain = render()
  const rows = rowsOf(out).length
  assert.equal(plain.filter((l) => l.includes(PLACEHOLDER)).length, rows)
  assert.ok(!plain.some((l) => l.includes('$$') || l.includes('∑')))

  const cellmath = join(process.env.HOME ?? '', 'dev/cellmath/pi/patch.ts')
  if (existsSync(cellmath)) {
    const { installCellmath } = await import(cellmath)
    const undo = installCellmath(Markdown.prototype)
    try {
      assert.deepEqual(render(), plain)
    } finally {
      undo?.()
    }
  }
  done()
})
