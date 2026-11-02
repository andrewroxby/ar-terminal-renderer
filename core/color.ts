// Card color from a theme background escape such as "\x1b[48;2;40;44;52m".
// A light card would wash out the light strokes the model is told to draw,
// so anything bright falls back to the dark default.

export const DEFAULT_CARD = '#1e1e2e'

export function cardColor(bgAnsi: string | undefined): string {
  const m = bgAnsi ? /48;2;(\d+);(\d+);(\d+)/.exec(bgAnsi) : null
  if (!m) return DEFAULT_CARD
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (r > 255 || g > 255 || b > 255) return DEFAULT_CARD
  const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  if (luma > 0.35) return DEFAULT_CARD
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')
}
