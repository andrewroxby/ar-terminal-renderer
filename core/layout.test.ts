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
