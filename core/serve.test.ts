import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { serve } from './serve.ts'

const hasRsvg = spawnSync('rsvg-convert', ['--version']).status === 0
const opts = { skip: hasRsvg ? false : 'rsvg-convert missing' }

interface Answer {
  id?: unknown
  path?: string
  error?: string
  rejected?: boolean
}

// Runs a server in this process and talks to it like a client would.
function start(idleMs?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'artr-serve-'))
  const input = new PassThrough()
  const output = new PassThrough()
  const answers: Answer[] = []
  let buf = ''
  const waiting: (() => void)[] = []
  output.on('data', (d: Buffer) => {
    buf += d.toString()
    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
      answers.push(JSON.parse(buf.slice(0, nl)))
      buf = buf.slice(nl + 1)
      waiting.splice(0).forEach((w) => w())
    }
  })
  const finished = serve(input, output, { cacheDir: join(dir, 'cache'), idleMs })
  const ask = (req: object): void => void input.write(JSON.stringify(req) + '\n')
  const answered = async (n: number): Promise<Answer[]> => {
    while (answers.length < n) await new Promise<void>((r) => waiting.push(r))
    return answers
  }
  const end = async (): Promise<void> => {
    input.end()
    await finished
    rmSync(dir, { recursive: true, force: true })
  }
  return { dir, ask, answered, answers, end, finished, input }
}

test('answers tex requests with a cached PNG path, by id, and repeats from the cache', opts, async () => {
  const s = start()
  s.ask({ id: 'a', tex: 'x^2 + \\frac{a}{b}', display: true, emPx: 24, cell: '9x20' })
  s.ask({ id: 'b', tex: 'y', display: false, emPx: 12, cell: '9x20' })
  const got = await s.answered(2)
  for (const a of got) {
    assert.ok(a.path && existsSync(a.path) && a.path.endsWith('.png'), JSON.stringify(a))
    assert.equal(readFileSync(a.path).toString('latin1', 1, 4), 'PNG')
  }
  assert.deepEqual(got.map((a) => a.id).sort(), ['a', 'b'])
  s.ask({ id: 'c', tex: 'x^2 + \\frac{a}{b}', display: true, emPx: 24, cell: '9x20' })
  const again = (await s.answered(3)).find((a) => a.id === 'c')!
  assert.equal(again.path, got.find((a) => a.id === 'a')!.path)
  await s.end()
})

test('refuses bad input per request and keeps serving', opts, async () => {
  const s = start()
  s.ask({ id: 1, tex: '\\frac{1}{' })
  s.ask({ id: 2, tex: 'x', color: 'red' })
  s.ask({ id: 3, tex: '   ' })
  s.ask({ id: 4, op: 'svg', tex: 'x' })
  s.input.write('not json\n')
  s.ask({ id: 5, tex: 'x', emPx: -1 })
  s.ask({ id: 6, tex: 'z' })
  const got = await s.answered(7)
  const by = (id: unknown): Answer => got.find((a) => a.id === id)!
  for (const id of [1, 2, 3, 4, 5]) assert.equal(by(id).rejected, true, `${id}: ${by(id).error}`)
  assert.match(by(1).error!, /could not typeset/)
  assert.match(by(2).error!, /--color/)
  assert.match(by(4).error!, /unknown op/)
  assert.equal(got.find((a) => a.id === undefined)!.rejected, true, 'a line that is not JSON')
  assert.ok(by(6).path)
  await s.end()
})

test('a failed render is not a refusal', opts, async () => {
  const saved = process.env.PATH
  process.env.PATH = '/nonexistent'
  const s = start()
  try {
    s.ask({ id: 1, tex: 'q' })
    const [a] = await s.answered(1)
    assert.equal(a!.rejected, false)
    assert.match(a!.error!, /rendering failed/)
  } finally {
    process.env.PATH = saved
    await s.end()
  }
})

test('exits when its input closes, after the answers it owes', opts, async () => {
  const s = start()
  for (let i = 0; i < 6; i++) s.ask({ id: i, tex: `a_{${i}}` })
  s.input.end()
  await s.finished
  assert.equal(s.answers.length, 6)
  rmSync(s.dir, { recursive: true, force: true })
})

test('exits on its own after sitting idle', async () => {
  const s = start(80)
  const t0 = Date.now()
  await s.finished
  assert.ok(Date.now() - t0 >= 70)
  rmSync(s.dir, { recursive: true, force: true })
})
