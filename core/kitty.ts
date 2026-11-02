// Kitty graphics framing and Unicode placeholder rows. Nothing here reads
// from the terminal, and under tmux every APC is wrapped for passthrough.

import { DIACRITICS } from './diacritics.ts'

export const PLACEHOLDER = String.fromCodePoint(0x10eeee)
export const CHUNK = 4096

const ESC = '\x1b'

// tmux passthrough: DCS tmux ; <payload with every ESC doubled> ST.
export function wrapTmux(seq: string): string {
  return `${ESC}Ptmux;${seq.replaceAll(ESC, ESC + ESC)}${ESC}\\`
}

function apc(control: string, payload: string, tmux: boolean): string {
  const seq = `${ESC}_G${control};${payload}${ESC}\\`
  return tmux ? wrapTmux(seq) : seq
}

// One APC per 4096-byte slice of base64. Transmit-and-display a virtual
// placement (U=1) of a PNG (f=100), quiet (q=2), sized to cols x rows cells.
export function transmit(id: number, png: Buffer, cols: number, rows: number, tmux: boolean): string[] {
  const b64 = png.toString('base64')
  const out: string[] = []
  for (let i = 0; i < b64.length || i === 0; i += CHUNK) {
    const more = i + CHUNK < b64.length ? 1 : 0
    const control =
      i === 0 ? `a=T,U=1,f=100,q=2,i=${id},c=${cols},r=${rows},m=${more}` : `q=2,m=${more}`
    out.push(apc(control, b64.slice(i, i + CHUNK), tmux))
  }
  return out
}

// Transmit by file path (t=f): one escape, no chunking, so nothing can
// interleave with another process. Only for a terminal that shares this
// machine's filesystem.
export function transmitFile(id: number, path: string, cols: number, rows: number, tmux: boolean): string {
  return apc(`a=T,U=1,f=100,t=f,q=2,i=${id},c=${cols},r=${rows}`, Buffer.from(path).toString('base64'), tmux)
}

// The image id rides in the foreground color, so rows carry a truecolor SGR.
export function placeholderRows(id: number, cols: number, rows: number): string[] {
  const fg = `${ESC}[38;2;${(id >> 16) & 255};${(id >> 8) & 255};${id & 255}m`
  const reset = `${ESC}[39m`
  if (cols > DIACRITICS.length || rows > DIACRITICS.length) return []
  const out: string[] = []
  for (let r = 0; r < rows; r++) {
    let line = ''
    for (let c = 0; c < cols; c++) line += PLACEHOLDER + DIACRITICS[r] + DIACRITICS[c]
    out.push(fg + line + reset)
  }
  return out
}
