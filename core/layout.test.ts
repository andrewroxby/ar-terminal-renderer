import { test } from 'node:test'
import assert from 'node:assert/strict'
import { layout, PAD } from './layout.ts'

const cell = { w: 9, h: 18 }

test('wide figure is capped by columns and letterboxed to whole cells', () => {
  const l = layout(1800, 300, 200, cell, 2)
  assert.equal(l.cols, 100)
  assert.equal(l.pxW, 100 * 9)
  assert.equal(l.pxH, l.rows * 18)
  assert.ok(l.rows <= 30)
  assert.ok(l.left >= PAD - 1 && l.top >= 0)
  assert.ok(l.left + l.fitW <= l.pxW && l.top + l.fitH <= l.pxH)
})

test('narrow terminal caps columns at width - 2', () => {
  const l = layout(900, 600, 40, cell, 2)
  assert.equal(l.cols, 38)
})

test('tall figure is capped at 30 rows', () => {
  const l = layout(100, 2000, 200, cell, 2)
  assert.equal(l.rows, 30)
  assert.ok(l.cols < 100)
})

test('small figure is not blown up past maxScale', () => {
  const l = layout(100, 50, 200, cell, 2)
  assert.equal(l.fitW, 200)
  assert.equal(layout(100, 50, 200, cell, 1).fitW, 100)
})

test('aspect ratio is kept', () => {
  const l = layout(400, 100, 120, cell, 2)
  assert.ok(Math.abs(l.fitW / l.fitH - 4) < 0.05)
})

test('card figures indent as transparent space left of the card', () => {
  const flush = layout(200, 100, 80, cell, 2, 0)
  const l = layout(200, 100, 80, cell, 2, 2)
  assert.equal(flush.cardX, 0)
  assert.equal(l.cardX, 18)
  assert.equal(l.cols, flush.cols + 2)
  assert.equal(l.pxW, flush.pxW + 18)
  assert.equal(l.left, flush.left + 18)
  assert.equal(l.fitW, flush.fitW)
  assert.equal(layout(200, 100, 80, cell, 2, 3).cardX, 27)
})

test('a wide figure drops the indent when the pane is too narrow, keeps it when only the cap binds', () => {
  // 1800 units at 2x wants 400 columns.
  const narrow = layout(1800, 300, 40, cell, 2, 2)
  assert.equal(narrow.cardX, 0)
  assert.equal(narrow.cols, 38)
  const roomy = layout(1800, 300, 190, cell, 2, 2)
  assert.equal(roomy.cardX, 18)
  assert.equal(roomy.cols, 102)
  assert.equal(roomy.fitW, layout(1800, 300, 190, cell, 2, 0).fitW)
  // Just past the cap plus indent: the pane (101 - 2 = 99 columns) cannot hold 100.
  assert.equal(layout(1800, 300, 101, cell, 2, 2).cardX, 0)
  assert.equal(layout(1800, 300, 104, cell, 2, 2).cardX, 18)
  // A small figure fits either way.
  assert.equal(layout(100, 50, 40, cell, 2, 2).cardX, 18)
})

test('height-bound figures keep the indent', () => {
  assert.equal(layout(100, 2000, 60, cell, 2, 2).cardX, 18)
})
