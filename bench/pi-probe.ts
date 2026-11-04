// Bench-only Pi extension: loads the real adapter and logs every transformer
// call (time, size, width, message type, streaming) as JSON lines to the file
// in AR_BENCH_LOG. Used by bench/pi.ts.

import { appendFileSync } from 'node:fs'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { install } from '../pi/adapter.ts'

export default function probe(pi: ExtensionAPI): void {
  const log = process.env.AR_BENCH_LOG!
  const wrapped = new Proxy(pi, {
    get(target, key, recv) {
      if (key !== 'registerMarkdownTransformer') return Reflect.get(target, key, recv)
      return (t: Parameters<ExtensionAPI['registerMarkdownTransformer']>[0]) =>
        target.registerMarkdownTransformer((md, ctx) => {
          const t0 = performance.now()
          const out = t(md, ctx)
          const ms = performance.now() - t0
          appendFileSync(log, JSON.stringify({ at: Date.now(), ms, len: md.length, type: ctx.messageType, streaming: ctx.isStreaming, width: ctx.availableWidth, changed: out !== md }) + '\n')
          return out
        })
    },
  })
  install(wrapped as ExtensionAPI)
}
