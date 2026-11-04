// Small insertion-ordered LRU: reads and writes move a key to the end, and
// the oldest entry goes when the cap is exceeded.

export class Lru<K, V> {
  private m = new Map<K, V>()
  private cap: number
  private onEvict?: (key: K, value: V) => void

  constructor(cap: number, onEvict?: (key: K, value: V) => void) {
    this.cap = cap
    this.onEvict = onEvict
  }

  get size(): number {
    return this.m.size
  }

  has(key: K): boolean {
    return this.m.has(key)
  }

  get(key: K): V | undefined {
    if (!this.m.has(key)) return undefined
    const v = this.m.get(key)!
    this.m.delete(key)
    this.m.set(key, v)
    return v
  }

  set(key: K, value: V): void {
    this.m.delete(key)
    this.m.set(key, value)
    while (this.m.size > this.cap) {
      const [k, v] = this.m.entries().next().value as [K, V]
      this.m.delete(k)
      this.onEvict?.(k, v)
    }
  }

  // Drops the least recently used entry. False when there is none.
  dropOldest(): boolean {
    const first = this.m.entries().next()
    if (first.done) return false
    const [k, v] = first.value
    this.m.delete(k)
    this.onEvict?.(k, v)
    return true
  }

  values(): V[] {
    return [...this.m.values()]
  }

  clear(): void {
    this.m.clear()
  }
}
