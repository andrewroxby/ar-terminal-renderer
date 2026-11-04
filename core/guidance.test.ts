import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GUIDANCE, guidance } from './guidance.ts'

test('guidance names every drawable kind and stays short and single-line', () => {
  for (const word of ['```svg', '```mermaid', '![caption](/abs/path.png)', '$$']) assert.ok(GUIDANCE.includes(word), word)
  assert.ok(!GUIDANCE.includes('\n'))
  assert.ok(GUIDANCE.length < 1000)
})

test('guidance leaves out mermaid when it cannot be drawn', () => {
  const g = guidance(false)
  assert.ok(!/mermaid/i.test(g))
  assert.ok(g.startsWith('Your terminal draws pictures and LaTeX inline.'))
  assert.ok(g.includes('```svg') && g.includes('$$'))
  assert.equal(guidance(true), GUIDANCE)
})
