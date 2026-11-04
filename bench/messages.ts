// Synthetic assistant messages for the benches: coding-agent prose with a
// code fence every ~2 KB, plus figures or display math spread through it.

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = 'the render cache hit path scan fence block width cell message memo figure image model token stream frame update lines text'.split(' ')

function prose(r: () => number, chars: number): string {
  let s = ''
  while (s.length < chars) {
    const n = 8 + Math.floor(r() * 18)
    const sent: string[] = []
    for (let i = 0; i < n; i++) sent.push(WORDS[Math.floor(r() * WORDS.length)]!)
    s += sent.join(' ') + (r() < 0.2 ? ' `x_i` and $5 or $10.' : '.') + (r() < 0.25 ? '\n\n' : ' ')
  }
  return s.trimEnd() + '\n\n'
}

const CODE = '```ts\nexport function f(a: number): number {\n  const m = new Map<string, number>()\n  for (let i = 0; i < a; i++) m.set(String(i), i)\n  return m.size\n}\n```\n\n'

function svg(i: number): string {
  const c = (60 + ((i * 37) % 160)).toString(16).padStart(2, '0')
  let body = ''
  for (let k = 0; k < 8; k++) body += `<rect x="${10 + k * 30}" y="${20 + ((k * i) % 5) * 10}" width="24" height="60" fill="#${c}44aa" stroke="#fff"/>`
  return `<svg viewBox="0 0 280 120"><title>Fig ${i}</title>${body}<text x="20" y="108" fill="#fff" font-size="14">figure ${i}</text></svg>`
}

const tex = (i: number): string => `\\int_0^{${i + 2}} x^{${i + 1}} e^{-x}\\,dx = \\sum_{k=0}^{${i + 1}} \\frac{a_k}{k!}`

export type Extra = 'none' | 'figs3' | 'math12'

// A coding-agent style reply: prose with a code fence every ~2 KB, plus the
// extras spread evenly through it. `plain` has no marker at all.
export function message(bytes: number, extra: Extra, seed = 1, plain = false): string {
  const r = rng(seed)
  const n = extra === 'figs3' ? 3 : extra === 'math12' ? 12 : 0
  const parts: string[] = []
  const per = Math.floor(bytes / (n + 1))
  for (let i = 0; i <= n; i++) {
    let chunk = ''
    while (chunk.length < per) chunk += prose(r, Math.min(1800, per - chunk.length)) + (plain ? '' : CODE)
    parts.push(chunk)
    if (i < n) {
      const id = seed * 100 + i
      parts.push(extra === 'figs3' ? '```svg\n' + svg(id) + '\n```\n\n' : '$$\n' + tex(id) + '\n$$\n\n')
    }
  }
  return parts.join('')
}
