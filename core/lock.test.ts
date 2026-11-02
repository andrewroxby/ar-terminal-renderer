import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tryLock } from './lock.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'artr-lock-'))

test('second taker waits out its budget and gets null; release frees it', () => {
  const dir = tmp()
  const a = tryLock(dir, 50)!
  assert.ok(a)
  const t0 = Date.now()
  assert.equal(tryLock(dir, 60), null)
  assert.ok(Date.now() - t0 >= 55)
  a()
  assert.ok(!existsSync(join(dir, 'transmit.lock')))
  const b = tryLock(dir, 50)
  assert.ok(b)
  b!()
  rmSync(dir, { recursive: true })
})

test('a stale lock is stolen', () => {
  const dir = tmp()
  const lock = join(dir, 'transmit.lock')
  mkdirSync(lock)
  const old = new Date(Date.now() - 10_000)
  utimesSync(lock, old, old)
  const t0 = Date.now()
  const r = tryLock(dir, 500)
  assert.ok(r)
  assert.ok(Date.now() - t0 < 200)
  r!()
  rmSync(dir, { recursive: true })
})
