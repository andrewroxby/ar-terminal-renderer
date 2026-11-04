// Cross-process lock for inline (chunked) kitty transmission. Continuation
// chunks carry no image id, so two processes writing to one terminal at once
// would splice their chunks together. A mkdir lock in the cache directory
// serializes whole images. It waits briefly, steals a stale lock, and gives
// up rather than block rendering.

import { mkdirSync, rmdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const STALE_LOCK_MS = 3000
const SLEEP = new Int32Array(new SharedArrayBuffer(4))

export function tryLock(dir: string, waitMs: number, staleMs = STALE_LOCK_MS): (() => void) | null {
  const lock = join(dir, 'transmit.lock')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    return null
  }
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      mkdirSync(lock)
      return () => {
        try {
          rmdirSync(lock)
        } catch {}
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return null
    }
    try {
      if (Date.now() - statSync(lock).mtimeMs > staleMs) {
        try {
          rmdirSync(lock)
        } catch {}
        continue
      }
    } catch {
      continue // vanished between mkdir and stat; try again
    }
    if (Date.now() >= deadline) return null
    Atomics.wait(SLEEP, 0, 0, 5)
  }
}
