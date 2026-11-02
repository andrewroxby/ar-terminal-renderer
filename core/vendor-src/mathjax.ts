// MathJax 3 (mathjax-full), TeX in and SVG out, with no DOM. Bundled by
// esbuild into core/vendor/mathjax.cjs so the live path needs no node_modules.

import { mathjax } from 'mathjax-full/js/mathjax.js'
import { TeX } from 'mathjax-full/js/input/tex.js'
import { SVG } from 'mathjax-full/js/output/svg.js'
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js'
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js'
import 'mathjax-full/js/input/tex/base/BaseConfiguration.js'
import 'mathjax-full/js/input/tex/ams/AmsConfiguration.js'
import 'mathjax-full/js/input/tex/boldsymbol/BoldsymbolConfiguration.js'
import 'mathjax-full/js/input/tex/mathtools/MathtoolsConfiguration.js'
import 'mathjax-full/js/input/tex/physics/PhysicsConfiguration.js'
import 'mathjax-full/js/input/tex/cancel/CancelConfiguration.js'
import 'mathjax-full/js/input/tex/color/ColorConfiguration.js'
import 'mathjax-full/js/input/tex/newcommand/NewcommandConfiguration.js'
import 'mathjax-full/js/input/tex/upgreek/UpgreekConfiguration.js'
import 'mathjax-full/js/input/tex/textmacros/TextMacrosConfiguration.js'
import 'mathjax-full/js/input/tex/configmacros/ConfigMacrosConfiguration.js'

const adaptor = liteAdaptor()
RegisterHTMLHandler(adaptor)

const tex = new TeX({
  packages: ['base', 'ams', 'boldsymbol', 'mathtools', 'physics', 'cancel', 'color', 'newcommand', 'upgreek', 'textmacros', 'configmacros'],
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
