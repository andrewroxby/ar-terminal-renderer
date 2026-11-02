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
