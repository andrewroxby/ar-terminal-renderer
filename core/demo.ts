// `ar-term-render demo [FILE]`: runs the real Renderer over a Markdown file at
// the terminal's width and prints the result, so the left indent and the
// figures can be judged without a model. Image data goes out first, as it does
// in a host, then the transformed text. The images stay on screen after exit.

import { readFileSync } from 'node:fs'
import process from 'node:process'
import { Renderer } from './render.ts'

const DEMO_FILE = new URL('./demo.md', import.meta.url)
const MAX_ROUNDS = 6
// A background render that never lands must not hold the demo forever.
const WAIT_MS = 15_000

export async function runDemo(file: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const markdown = readFileSync(file ?? DEMO_FILE, 'utf8')
  const width = Math.max(10, (process.stdout.columns || 80) - 1)
  const renderer = new Renderer({ write: (data) => void process.stdout.write(data), env })

  // The background timers are unref'd, so this one keeps the process alive.
  const hold = setTimeout(() => {}, WAIT_MS)
  let text = markdown
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      text = renderer.transform(markdown, { width })
      if (!renderer.pending()) break
      await Promise.race([renderer.idle(), new Promise((r) => setTimeout(r, WAIT_MS).unref())])
    }
  } finally {
    clearTimeout(hold)
    renderer.forget()
  }
  process.stdout.write(text.endsWith('\n') ? text : text + '\n')
}
