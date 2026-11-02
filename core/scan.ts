// Fence-aware scanner. Finds closed top-level fences whose language the
// caller wants, and standalone PNG image lines. Fences nested inside another
// fence, and fences still open at the end of the text (streaming), are left
// alone.

export type Block =
  | ({ kind: 'fence'; lang: string; body: string } & Span)
  | ({ kind: 'math'; body: string } & Span)
  | ({ kind: 'image'; alt: string; path: string } & Span)

// indent is the run of spaces before the block's first line (at most three).
interface Span {
  start: number
  end: number
  indent: string
}

// Display math follows Pi's own block LaTeX tokenizer (pi-tui's markdown.js,
// tokenizeBlockLatex): an opening `$$` or `\[` at the start of a line, and
// the first matching closer that ends a line. Nothing is skipped for
// backslashes, so `$$a \\$$` closes where Pi closes it. A block with a blank
// line inside, or with no closer, is left alone, as is inline math.
//
// start/end are character offsets covering the block's lines, excluding the
// newline after its last line.

const OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/
const MATH_OPEN = /^ {0,3}(\$\$|\\\[)/
const MAX_MATH = 8000
const BLOCK_LATEX = {
  '$$': /^ {0,3}\$\$([ \t]*\n?)([\s\S]*?)\$\$[ \t]*\r?(?:\n|$)/,
  '\\[': /^ {0,3}\\\[([ \t]*\n?)([\s\S]*?)\\\][ \t]*\r?(?:\n|$)/,
} as const

// Finds the end of the display math block opening at `lineStart`.
function findMath(md: string, lineStart: number, opener: keyof typeof BLOCK_LATEX): { body: string; end: number } | null {
  // The window bounds the lazy scan; a block that needs more is too long.
  const m = BLOCK_LATEX[opener].exec(md.slice(lineStart, lineStart + MAX_MATH + 100))
  if (!m) return null
  const body = m[2]!
  if (body.length > MAX_MATH || !body.trim() || /\n[ \t\r]*\n/.test(m[1]! + body)) return null
  let end = lineStart + m[0].length
  if (md[end - 1] === '\n') end--
  if (md[end - 1] === '\r') end--
  return { body, end }
}

const IMAGE = /^ {0,3}!\[([^\]\n]*)\]\((\/[^)\n]+\.png)\)[ \t]*$/i

const indentOf = (line: string): string => /^ */.exec(line)![0]

export function scan(markdown: string, fenceLangs: ReadonlySet<string>): Block[] {
  const blocks: Block[] = []
  let pos = 0
  let fence: { char: string; len: number; lang: string; start: number; bodyStart: number; indent: string } | null = null

  while (pos <= markdown.length) {
    const nl = markdown.indexOf('\n', pos)
    const lineEnd = nl === -1 ? markdown.length : nl
    const line = markdown.slice(pos, lineEnd).replace(/\r$/, '')

    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.len) {
        if (fenceLangs.has(fence.lang)) {
          const body = markdown.slice(fence.bodyStart, Math.max(fence.bodyStart, pos - 1))
          blocks.push({ kind: 'fence', lang: fence.lang, body, start: fence.start, end: lineEnd, indent: fence.indent })
        }
        fence = null
      }
    } else {
      const open = OPEN.exec(line)
      if (open) {
        fence = {
          char: open[1]![0]!,
          len: open[1]!.length,
          lang: open[2]!.toLowerCase(),
          start: pos,
          indent: indentOf(line),
          bodyStart: nl === -1 ? markdown.length : nl + 1,
        }
      } else {
        const mo = MATH_OPEN.exec(line)
        const math = mo ? findMath(markdown, pos, mo[1]! as keyof typeof BLOCK_LATEX) : null
        if (math) {
          blocks.push({ kind: 'math', body: math.body, start: pos, end: math.end, indent: indentOf(line) })
          const after = markdown.indexOf('\n', math.end)
          if (after === -1) break
          pos = after + 1
          continue
        }
        const img = IMAGE.exec(line)
        if (img) {
          blocks.push({ kind: 'image', alt: img[1]!.trim(), path: img[2]!.trim(), start: pos, end: lineEnd, indent: indentOf(line) })
        }
      }
    }

    if (nl === -1) break
    pos = nl + 1
  }
  return blocks
}
