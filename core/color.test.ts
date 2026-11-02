import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cardColor, DEFAULT_CARD } from './color.ts'

test('dark theme backgrounds are used, light ones and junk fall back', () => {
  assert.equal(cardColor('\x1b[48;2;40;44;52m'), '#282c34')
  assert.equal(cardColor('\x1b[48;2;250;250;250m'), DEFAULT_CARD)
  assert.equal(cardColor('\x1b[48;5;236m'), DEFAULT_CARD)
  assert.equal(cardColor(undefined), DEFAULT_CARD)
})
