// Sizing. A figure fits a box of at most min(width - 2, 100) columns by 30
// rows, is centered on a card padded by PAD pixels, and the card is rounded
// up to whole cells so the placeholder grid matches the image exactly.

export interface Cell {
  w: number
  h: number
}

export interface Layout {
  cols: number
  rows: number
  pxW: number
  pxH: number
  fitW: number
  fitH: number
  left: number
  top: number
}

export const MAX_COLS = 100
export const MAX_ROWS = 30
export const PAD = 6
export const DEFAULT_CELL: Cell = { w: 9, h: 18 }

export function layout(vw: number, vh: number, width: number, cell: Cell, maxScale: number): Layout {
  const maxCols = Math.max(1, Math.min(width - 2, MAX_COLS))
  const boxW = Math.max(1, maxCols * cell.w - 2 * PAD)
  const boxH = Math.max(1, MAX_ROWS * cell.h - 2 * PAD)
  const scale = Math.min(boxW / vw, boxH / vh, maxScale)
  const fitW = Math.max(1, Math.round(vw * scale))
  const fitH = Math.max(1, Math.round(vh * scale))
  const cols = Math.max(1, Math.min(maxCols, Math.ceil((fitW + 2 * PAD) / cell.w)))
  const rows = Math.max(1, Math.min(MAX_ROWS, Math.ceil((fitH + 2 * PAD) / cell.h)))
  const pxW = cols * cell.w
  const pxH = rows * cell.h
  return {
    cols,
    rows,
    pxW,
    pxH,
    fitW,
    fitH,
    left: Math.floor((pxW - fitW) / 2),
    top: Math.floor((pxH - fitH) / 2),
  }
}

// Display math is set at 0.8 em per cell height, which roughly matches the
// terminal font's own letters, indented MATH_INDENT cells with no card, and
// shrunk only when it would overflow the box. The indent is blank space inside
// the image, because Markdown strips leading spaces from a paragraph. vw and
// vh are in MathJax's 1000-units-per-em space.
export const MATH_EM = 0.8
export const MATH_INDENT = 2

export function layoutMath(vw: number, vh: number, width: number, cell: Cell): Layout {
  const indent = width - 2 > MATH_INDENT + 8 ? MATH_INDENT : 0
  const maxCols = Math.max(1, Math.min(width - 2, MAX_COLS) - indent)
  const scale = Math.min((cell.h * MATH_EM) / 1000, (maxCols * cell.w) / vw, (MAX_ROWS * cell.h) / vh)
  const fitW = Math.max(1, Math.round(vw * scale))
  const fitH = Math.max(1, Math.round(vh * scale))
  const cols = indent + Math.max(1, Math.min(maxCols, Math.ceil(fitW / cell.w)))
  const rows = Math.max(1, Math.min(MAX_ROWS, Math.ceil(fitH / cell.h)))
  const pxW = cols * cell.w
  const pxH = rows * cell.h
  return { cols, rows, pxW, pxH, fitW, fitH, left: indent * cell.w, top: Math.floor((pxH - fitH) / 2) }
}
