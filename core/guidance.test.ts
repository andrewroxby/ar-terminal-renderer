import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GUIDANCE } from './guidance.ts'

test('guidance names every drawable kind and stays short and single-line', () => {
  for (const word of ['```svg', '```mermaid', '![caption](/abs/path.png)', '$$']) assert.ok(GUIDANCE.includes(word), word)
  assert.ok(!GUIDANCE.includes('\n'))
  assert.ok(GUIDANCE.length < 1000)
})
