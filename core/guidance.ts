// The one line injected into the system prompt when pictures can be drawn.
// Keep it byte-identical across turns so the prompt cache holds.

const OPEN = (mermaid: boolean): string =>
  `Your terminal draws ${mermaid ? 'pictures, Mermaid diagrams' : 'pictures'} and LaTeX inline.`
const USE =
  ' Use them whenever information, an explanation, a point, a plan, or a solution is better conveyed or communicated visually or, in the case of math, quantitatively. For pictures, draw each as one self-contained ```svg block with a viewBox and a `<title>`, or as `![caption](/abs/path.png)` alone on a line for a PNG you wrote.'
const MERMAID = ' For flow, sequence, state, class or ER diagrams, write a ```mermaid block instead.'
const TAIL =
  ' Use light strokes and text, labels of 12+ units, and at most 900×600. Keep to at most a few figures per reply, skip figures that only decorate, and never draw plain text or tables. Write math as LaTeX; $$…$$ or \\[…\\] display blocks are typeset as pictures. Explain each figure briefly in context.'

// Mermaid is mentioned only where the host can draw it.
export const guidance = (mermaid: boolean): string => OPEN(mermaid) + USE + (mermaid ? MERMAID : '') + TAIL

export const GUIDANCE = guidance(true)
