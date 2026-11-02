// SVG sanitizing for rsvg-convert. Returns null for anything we refuse to
// draw. Output has an xmlns, a viewBox and no width/height on the root, so
// the aspect ratio comes from the viewBox alone.

export const MAX_SVG_BYTES = 200 * 1024

export interface CleanSvg {
  svg: string
  vw: number
  vh: number
  title: string
}

const DEFAULT_VIEWBOX = [0, 0, 800, 600] as const

export function sanitizeSvg(source: string): CleanSvg | null {
  if (Buffer.byteLength(source) > MAX_SVG_BYTES) return null

  let s = source.trim()
  if (/<!ENTITY/i.test(s)) return null
  s = s.replace(/<!DOCTYPE[^>[]*>/gi, '')
  if (/<!DOCTYPE/i.test(s)) return null
  s = s.replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')

  const rootMatch = /<svg\b[^>]*>/i.exec(s)
  if (!rootMatch) return null

  // Only data: and same-document (#) references survive.
  s = s.replace(/\s(?:xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi, (attr, a: string | undefined, b: string | undefined) => {
    const value = (a ?? b ?? '').trim()
    return /^(data:|#)/i.test(value) ? attr : ''
  })
  s = s.replace(/@import\b[^;}]*[;}]?/gi, '')
  s = s.replace(/url\(\s*(['"]?)(?!#|data:)[^)]*\)/gi, 'none')

  // Re-find the root tag; stripping above never moves it, but offsets shift.
  const root = /<svg\b[^>]*>/i.exec(s)!
  let tag = root[0]

  const attr = (name: string): string | null => {
    const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag)
    return m ? (m[1] ?? m[2] ?? '') : null
  }
  const num = (v: string | null): number | null => {
    if (v === null) return null
    const m = /^\s*([0-9]*\.?[0-9]+)\s*(px)?\s*$/i.exec(v)
    return m ? parseFloat(m[1]!) : null
  }

  let box: number[] | null = null
  const vb = attr('viewBox')
  if (vb) {
    const parts = vb.trim().split(/[\s,]+/).map(Number)
    if (parts.length === 4 && parts.every(Number.isFinite) && parts[2]! > 0 && parts[3]! > 0) box = parts
  }
  if (!box) {
    const w = num(attr('width'))
    const h = num(attr('height'))
    box = w && h ? [0, 0, w, h] : [...DEFAULT_VIEWBOX]
  }

  const stripAttr = (name: string): void => {
    tag = tag.replace(new RegExp(`\\s${name}\\s*=\\s*(?:"[^"]*"|'[^']*')`, 'i'), '')
  }
  stripAttr('width')
  stripAttr('height')
  stripAttr('viewBox')
  tag = tag.replace(/^<svg\b/i, `<svg viewBox="${box.join(' ')}"`)
  if (!/\sxmlns\s*=/.test(tag)) tag = tag.replace(/^<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"')
  if (/xlink:/.test(s) && !/\sxmlns:xlink\s*=/.test(tag)) {
    tag = tag.replace(/^<svg\b/i, '<svg xmlns:xlink="http://www.w3.org/1999/xlink"')
  }
  s = s.slice(0, root.index) + tag + s.slice(root.index + root[0].length)
  // Drop anything before the root (xml prolog, comments) for a tidy document.
  s = s.slice(s.search(/<svg\b/i))

  const t = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(s)
  const title = t ? decode(t[1]!.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim().slice(0, 80) : ''

  return { svg: s, vw: box[2]!, vh: box[3]!, title }
}

function decode(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}
