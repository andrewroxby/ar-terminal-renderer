import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Lru } from './lru.ts'

test('evicts the least recently used key past the cap, reads refresh', () => {
  const gone: string[] = []
  const c = new Lru<string, number>(2, (k) => gone.push(k))
  c.set('a', 1)
  c.set('b', 2)
  c.get('a')
  c.set('c', 3)
  assert.deepEqual(gone, ['b'])
  assert.equal(c.size, 2)
  assert.deepEqual(c.values(), [1, 3])
  assert.equal(c.has('b'), false)
})

test('dropOldest evicts like a cap would, and says when there is nothing left', () => {
  const gone: string[] = []
  const c = new Lru<string, number>(5, (k) => gone.push(k))
  c.set('a', 1)
  c.set('b', 2)
  c.get('a')
  assert.equal(c.dropOldest(), true)
  assert.deepEqual(gone, ['b'])
  assert.equal(c.dropOldest(), true)
  assert.equal(c.dropOldest(), false)
  assert.equal(c.size, 0)
})
