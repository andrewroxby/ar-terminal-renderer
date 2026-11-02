// librsvg ignores CSS custom properties and color-mix(), which
// beautiful-mermaid's SVG leans on. This resolves them to plain colors, so
// the SVG is drawn the way its theme intends.

const VAR_DECL = /(--[\w-]+)\s*:\s*([^;"}]+)/g

type Rgb = [number, number, number]

function parseColor(s: string): Rgb | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s.trim())
  if (!m) return null
  const h = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join('') : m[1]!
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

const hex = (c: Rgb): string => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')

// Splits on top-level commas.
function splitArgs(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out.map((a) => a.trim())
}

// Index of the ")" that closes the "(" at `open`.
function closeParen(s: string, open: number): number {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++
    else if (s[i] === ')' && --depth === 0) return i
  }
  return -1
}

function evaluate(expr: string, vars: Map<string, string>, depth = 0): string {
  const e = expr.trim()
  if (depth > 20) return e
  if (e.startsWith('var(')) {
    const [name, ...rest] = splitArgs(e.slice(4, closeParen(e, 3)))
    const v = vars.get(name!)
    return v !== undefined ? evaluate(v, vars, depth + 1) : evaluate(rest.join(','), vars, depth + 1)
  }
  if (e.startsWith('color-mix(')) {
    // color-mix(in srgb, A p%, B [q%])
    const args = splitArgs(e.slice(10, closeParen(e, 9))).slice(1)
    const part = (a: string): { c: Rgb | null; w: number | null } => {
      const m = /^(.*?)(?:\s+([\d.]+)%)?$/.exec(a)!
      return { c: parseColor(evaluate(m[1]!, vars, depth + 1)), w: m[2] ? parseFloat(m[2]) : null }
    }
    const a = part(args[0]!)
    const b = part(args[1]!)
    if (!a.c || !b.c) return e
    const wa = a.w ?? (b.w !== null ? 100 - b.w : 50)
    return hex(a.c.map((v, i) => (v * wa + b.c![i]! * (100 - wa)) / 100) as Rgb)
  }
  return e
}

// Replaces every var(...) in the document with its resolved value.
export function flattenCssVars(svg: string): string {
  const vars = new Map<string, string>()
  for (const m of svg.matchAll(VAR_DECL)) vars.set(m[1]!, m[2]!.trim())

  let out = ''
  let i = 0
  for (;;) {
    const at = svg.indexOf('var(', i)
    if (at < 0) break
    const end = closeParen(svg, at + 3)
    if (end < 0) break
    out += svg.slice(i, at) + evaluate(svg.slice(at, end + 1), vars)
    i = end + 1
  }
  return out + svg.slice(i)
}
