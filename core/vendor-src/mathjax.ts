// MathJax 3 (mathjax-full), TeX in and SVG out, with no DOM. Bundled by
// esbuild into core/vendor/mathjax.cjs so the live path needs no node_modules.

import { mathjax } from 'mathjax-full/js/mathjax.js'
import { TeX } from 'mathjax-full/js/input/tex.js'
import { SVG } from 'mathjax-full/js/output/svg.js'
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js'
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js'
import { MapHandler } from 'mathjax-full/js/input/tex/MapHandler.js'
import type { CommandMap } from 'mathjax-full/js/input/tex/SymbolMap.js'
import 'mathjax-full/js/input/tex/base/BaseConfiguration.js'
import 'mathjax-full/js/input/tex/ams/AmsConfiguration.js'
import 'mathjax-full/js/input/tex/boldsymbol/BoldsymbolConfiguration.js'
import 'mathjax-full/js/input/tex/mathtools/MathtoolsConfiguration.js'
import 'mathjax-full/js/input/tex/physics/PhysicsConfiguration.js'
import 'mathjax-full/js/input/tex/cancel/CancelConfiguration.js'
import 'mathjax-full/js/input/tex/color/ColorConfiguration.js'
import 'mathjax-full/js/input/tex/upgreek/UpgreekConfiguration.js'
import 'mathjax-full/js/input/tex/textmacros/TextMacrosConfiguration.js'

// The bundle lives for the whole process, and macro maps are shared across
// TeX instances, so a command that defines or configures anything would
// change every later expression. The newcommand and configmacros packages
// are left out, and these commands from the packages that remain are
// removed, so a block that tries one fails and keeps its original text.
const STATEFUL: Record<string, string[]> = {
  'AMSmath-macros': ['DeclareMathOperator'],
  'mathtools-macros': [
    'DeclarePairedDelimiter',
    'DeclarePairedDelimiterX',
    'DeclarePairedDelimiterXPP',
    'DeclarePairedDelimiters',
    'DeclarePairedDelimitersX',
    'DeclarePairedDelimitersXPP',
    'newtagform',
    'renewtagform',
    'usetagform',
    'mathtoolsset',
  ],
  color: ['definecolor'],
}
for (const [map, names] of Object.entries(STATEFUL)) {
  const m = MapHandler.getMap(map) as CommandMap | undefined
  if (!m) throw new Error(`MathJax map ${map} not found`)
  for (const name of names) m.remove(name)
}

const adaptor = liteAdaptor()
RegisterHTMLHandler(adaptor)

const tex = new TeX({
  packages: ['base', 'ams', 'boldsymbol', 'mathtools', 'physics', 'cancel', 'color', 'upgreek', 'textmacros'],
  // Equations are never auto-numbered; the caller rewrites \tag.
  tags: 'none',
  // Errors throw, so the caller can fall back instead of drawing a red box.
  formatError: (_jax: unknown, err: Error) => {
    throw err
  },
})
const svg = new SVG({ fontCache: 'none' })
const doc = mathjax.document('', { InputJax: tex, OutputJax: svg })

// Returns the <svg> element as a string; throws on a TeX error.
export function texToSvg(source: string, display = true): string {
  const node = doc.convert(source, { display })
  const html = adaptor.innerHTML(node)
  const m = /<svg[\s\S]*<\/svg>/.exec(html)
  if (!m) throw new Error('MathJax produced no SVG')
  if (/data-mml-node="merror"/.test(m[0])) throw new Error('MathJax reported an error')
  return m[0]
}
