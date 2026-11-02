import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeSvg, MAX_SVG_BYTES } from './svg.ts'

test('adds xmlns, keeps viewBox, drops width/height, reads title', () => {
  const r = sanitizeSvg('<svg width="100" height="50" viewBox="0 0 400 200"><title>A &amp; B</title></svg>')!
  assert.match(r.svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 400 200">/)
  assert.doesNotMatch(r.svg, /width=|height=/)
  assert.equal(r.title, 'A & B')
  assert.deepEqual([r.vw, r.vh], [400, 200])
})

test('viewBox comes from width/height when absent, else a default', () => {
  const a = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg" width="120px" height="60"/>')!
  assert.deepEqual([a.vw, a.vh], [120, 60])
  const b = sanitizeSvg('<svg/>')!
  assert.deepEqual([b.vw, b.vh], [800, 600])
})

test('keeps existing xmlns once', () => {
  const r = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>')!
  assert.equal(r.svg.match(/xmlns=/g)!.length, 1)
})

test('strips external href and xlink:href, keeps data: and #', () => {
  const r = sanitizeSvg(
    '<svg viewBox="0 0 9 9"><image href="file:///etc/passwd"/><image xlink:href="http://x/y.png"/><use xlink:href="#b"/><use href="#a"/><image href="data:image/png;base64,AAAA"/></svg>',
  )!
  assert.doesNotMatch(r.svg, /file:|http:\/\/x\//)
  assert.match(r.svg, /href="#a"/)
  assert.match(r.svg, /href="data:image\/png;base64,AAAA"/)
  assert.match(r.svg, /xmlns:xlink=/)
})

test('neutralizes external css url() and @import, keeps url(#id)', () => {
  const r = sanitizeSvg(
    '<svg viewBox="0 0 9 9"><style>@import url(http://e/x.css);</style><rect style="fill:url(file:///a)" fill="url(#g)"/></svg>',
  )!
  assert.doesNotMatch(r.svg, /@import|file:|e\/x\.css/)
  assert.match(r.svg, /url\(#g\)/)
})

test('rejects entities, oversize and non-svg', () => {
  assert.equal(sanitizeSvg('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>'), null)
  assert.equal(sanitizeSvg('<svg>' + 'x'.repeat(MAX_SVG_BYTES) + '</svg>'), null)
  assert.equal(sanitizeSvg('<html></html>'), null)
})

test('removes scripts and any prolog', () => {
  const r = sanitizeSvg('<?xml version="1.0"?>\n<!-- c -->\n<svg viewBox="0 0 1 1"><script>alert(1)</script></svg>')!
  assert.match(r.svg, /^<svg /)
  assert.doesNotMatch(r.svg, /script/)
})
