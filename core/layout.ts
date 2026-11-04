// Sizing. A figure fits a box of at most min(width - 2 - indent, 100) columns
// by 30 rows, is centered on a card padded by PAD pixels, and the card is
// rounded up to whole cells so the placeholder grid matches the image exactly.
//
// Figures sit INDENT cells in from the left and display math MATH_INDENT
// cells, as transparent space inside the image (Markdown strips leading spaces from a paragraph, so the
// indent cannot be text). A block drops the indent when keeping it would
// shrink the figure, which is when the pane is too narrow for the figure at
// its natural size.

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
  // Where the figure sits in the page.
  left: number
  top: number
  // Left edge of the card in pixels: the indent. Used only with a card.
  cardX: number
}

const MAX_COLS = 100
const MAX_ROWS = 30
export const PAD = 6
export const INDENT = 2
export const MATH_INDENT = 3
export const DEFAULT_CELL: Cell = { w: 9, h: 18 }

interface Fit {
  l: Layout
  scale: number
}

// Laying out with `indent` cells of blank space is kept only if it leaves the
// figure as large as laying it out flush.
function indentedUnlessShrunk(fit: (indent: number) => Fit, indent: number): Layout {
  const flush = fit(0)
  if (indent <= 0) return flush.l
  const ind = fit(indent)
  return ind.scale < flush.scale - 1e-9 ? flush.l : ind.l
}

export function layout(vw: number, vh: number, width: number, cell: Cell, maxScale: number, indent = 0): Layout {
  const fit = (ind: number): Fit => {
    const maxCols = Math.max(1, Math.min(width - 2 - ind, MAX_COLS))
    const boxW = Math.max(1, maxCols * cell.w - 2 * PAD)
    const boxH = Math.max(1, MAX_ROWS * cell.h - 2 * PAD)
    const scale = Math.min(boxW / vw, boxH / vh, maxScale)
    const fitW = Math.max(1, Math.round(vw * scale))
    const fitH = Math.max(1, Math.round(vh * scale))
    const cardCols = Math.max(1, Math.min(maxCols, Math.ceil((fitW + 2 * PAD) / cell.w)))
    const rows = Math.max(1, Math.min(MAX_ROWS, Math.ceil((fitH + 2 * PAD) / cell.h)))
    const cardX = ind * cell.w
    const cardW = cardCols * cell.w
    const pxH = rows * cell.h
    return {
      scale,
      l: {
        cols: ind + cardCols,
        rows,
        pxW: cardX + cardW,
        pxH,
        fitW,
        fitH,
        left: cardX + Math.floor((cardW - fitW) / 2),
        top: Math.floor((pxH - fitH) / 2),
        cardX,
      },
    }
  }
  return indentedUnlessShrunk(fit, indent)
}

// Display math is set at 0.8 em per cell height, which roughly matches the
// terminal font's own letters, with no card, and shrunk only when it would
// overflow the box. vw and vh are in MathJax's 1000-units-per-em space.
export const MATH_EM = 0.8

export function layoutMath(vw: number, vh: number, width: number, cell: Cell, indent = 0): Layout {
  const fit = (ind: number): Fit => {
    const maxCols = Math.max(1, Math.min(width - 2 - ind, MAX_COLS))
    const scale = Math.min((cell.h * MATH_EM) / 1000, (maxCols * cell.w) / vw, (MAX_ROWS * cell.h) / vh)
    const fitW = Math.max(1, Math.round(vw * scale))
    const fitH = Math.max(1, Math.round(vh * scale))
    const cols = ind + Math.max(1, Math.min(maxCols, Math.ceil(fitW / cell.w)))
    const rows = Math.max(1, Math.min(MAX_ROWS, Math.ceil(fitH / cell.h)))
    const pxW = cols * cell.w
    const pxH = rows * cell.h
    return { scale, l: { cols, rows, pxW, pxH, fitW, fitH, left: ind * cell.w, top: Math.floor((pxH - fitH) / 2), cardX: 0 } }
  }
  return indentedUnlessShrunk(fit, indent)
}
