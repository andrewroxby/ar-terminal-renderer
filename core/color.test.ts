import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cardColor, mathColor, DEFAULT_CARD, DEFAULT_MATH } from './color.ts'

test('dark theme backgrounds are used, light ones and junk fall back', () => {
  assert.equal(cardColor('\x1b[48;2;40;44;52m'), '#282c34')
  assert.equal(cardColor('\x1b[48;2;250;250;250m'), DEFAULT_CARD)
  assert.equal(cardColor('\x1b[48;5;236m'), DEFAULT_CARD)
  assert.equal(cardColor(undefined), DEFAULT_CARD)
})

test('math color is the theme text color as is, light or dark; junk falls back', () => {
  assert.equal(mathColor('\x1b[38;2;220;215;186m'), '#dcd7ba')
  assert.equal(mathColor('\x1b[38;2;20;20;20m'), '#141414')
  assert.equal(mathColor('\x1b[38;2;300;0;0m'), DEFAULT_MATH)
  assert.equal(mathColor(''), DEFAULT_MATH)
  assert.equal(mathColor(undefined), DEFAULT_MATH)
})
