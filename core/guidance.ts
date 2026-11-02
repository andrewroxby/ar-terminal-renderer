// The one line injected into the system prompt when pictures can be drawn.
// Keep it byte-identical across turns so the prompt cache holds.

const HEAD =
  'Your terminal draws pictures inline. When a picture explains faster than words (structure, flow, plots, geometry, layout), include one self-contained ```svg block with a viewBox and a `<title>`, or `![caption](/abs/path.png)` alone on a line for a PNG you wrote.'
const MERMAID = ' For flow, sequence, state, class or ER diagrams, write a ```mermaid block instead.'
const TAIL =
  ' Use light strokes and text, labels of 12+ units, and at most 900×600. One or two figures per reply at most. No decoration, and never for plain text or tables. Write math as LaTeX; $$…$$ or \\[…\\] display blocks are typeset as pictures. Say in a sentence what the figure shows.'

// Mermaid is mentioned only where the host can draw it.
export const guidance = (mermaid: boolean): string => HEAD + (mermaid ? MERMAID : '') + TAIL

export const GUIDANCE = guidance(true)
