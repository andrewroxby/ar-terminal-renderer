// Fence-aware scanner. Finds closed top-level fences whose language the
// caller wants, and standalone PNG image lines. Fences nested inside another
// fence, and fences still open at the end of the text (streaming), are left
// alone.

export type Block =
  | { kind: 'fence'; lang: string; body: string; start: number; end: number }
  | { kind: 'image'; alt: string; path: string; start: number; end: number }

// start/end are character offsets covering the block's lines, excluding the
// newline after its last line.

const OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/
const IMAGE = /^ {0,3}!\[([^\]\n]*)\]\((\/[^)\n]+\.png)\)[ \t]*$/i

export function scan(markdown: string, fenceLangs: ReadonlySet<string>): Block[] {
  const blocks: Block[] = []
  let pos = 0
  let fence: { char: string; len: number; lang: string; start: number; bodyStart: number } | null = null

  while (pos <= markdown.length) {
    const nl = markdown.indexOf('\n', pos)
    const lineEnd = nl === -1 ? markdown.length : nl
    const line = markdown.slice(pos, lineEnd).replace(/\r$/, '')

    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.len) {
        if (fenceLangs.has(fence.lang)) {
          const body = markdown.slice(fence.bodyStart, Math.max(fence.bodyStart, pos - 1))
          blocks.push({ kind: 'fence', lang: fence.lang, body, start: fence.start, end: lineEnd })
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
          bodyStart: nl === -1 ? markdown.length : nl + 1,
        }
      } else {
        const img = IMAGE.exec(line)
        if (img) {
          blocks.push({ kind: 'image', alt: img[1]!.trim(), path: img[2]!.trim(), start: pos, end: lineEnd })
        }
      }
    }

    if (nl === -1) break
    pos = nl + 1
  }
  return blocks
}
