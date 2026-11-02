import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { MermaidRunner, refuseMermaid } from './mermaid.ts'
import type { CleanSvg } from './svg.ts'
import { flattenCssVars } from './cssvars.ts'

const hasRsvg = spawnSync('rsvg-convert', ['--version']).status === 0

const SUPPORTED: Record<string, string> = {
  flowchartTD: 'graph TD\n A[Start] --> B{OK?}\n B -->|yes| C[Go]\n B -->|no| D[Stop]',
  flowchartLR: 'flowchart LR\n A --> B --> C\n subgraph S\n B\n end',
  sequence: 'sequenceDiagram\n Alice->>Bob: Hi\n Bob-->>Alice: Hello\n Note over Alice,Bob: hi',
  state: 'stateDiagram-v2\n [*] --> Idle\n Idle --> Busy: go\n Busy --> [*]',
  class: 'classDiagram\n class Animal {\n +name\n +speak()\n }\n Animal <|-- Dog',
  er: 'erDiagram\n CUSTOMER ||--o{ ORDER : places\n ORDER ||--|{ ITEM : has',
  xychart: 'xychart-beta\n title "x"\n x-axis [a,b,c]\n y-axis "v" 0 --> 10\n bar [1,5,3]',
}

async function convert(src: string, runner: MermaidRunner): Promise<CleanSvg | null> {
  const r = await runner.run(src, '#1e1e2e')
  return r.state === 'ok' ? r.svg : null
}

test('supported diagram types render to svg with no CSS variables left', async () => {
  const runner = new MermaidRunner()
  for (const [name, src] of Object.entries(SUPPORTED)) {
    const m = await convert(src, runner)
    assert.ok(m, name)
    assert.ok(m!.vw > 0 && m!.vh > 0, name)
    assert.doesNotMatch(m!.svg, /var\(--/, name)
    assert.doesNotMatch(m!.svg, /@import|googleapis|font-family:\s*'/, name)
  }
  runner.close()
})

test('supported diagrams rasterize', { skip: hasRsvg ? false : 'rsvg missing' }, async () => {
  const runner = new MermaidRunner()
  for (const [name, src] of Object.entries(SUPPORTED)) {
    const m = (await convert(src, runner))!
    assert.equal(spawnSync('rsvg-convert', ['-f', 'png', '-w', '200'], { input: m.svg }).status, 0, name)
  }
  runner.close()
})

test('unsupported types and junk are refused, so Pi draws the fence', async () => {
  const runner = new MermaidRunner()
  for (const src of ['pie title Pets\n "Dogs" : 386', 'gantt\n title A', 'journey\n title x', 'mindmap\n root((x))', 'hello world', '']) {
    const r = await runner.run(src, '#1e1e2e')
    assert.equal(r.state, 'bad', src)
  }
  runner.close()
})

// Three layers of 20 fully connected nodes took ten seconds to lay out.
const dense = (n: number): string => {
  const layer = (p: string) => Array.from({ length: n }, (_v, i) => `${p}${i}`).join(' & ')
  return `graph TD\n${layer('a')} --> ${layer('b')}\n${layer('b')} --> ${layer('c')}\n${layer('c')} --> ${layer('a')}`
}

test('dense graphs are refused up front by the cheap pre-filter', async () => {
  for (const n of [20, 40]) {
    const src = dense(n)
    assert.ok(refuseMermaid(src), `${n} per layer`)
  }
  assert.equal(refuseMermaid('graph TD\n A & B --> C & D'), null)
  assert.equal(refuseMermaid(SUPPORTED.flowchartTD!), null)
  // 150 nodes is fine, 160 is not, and ampersands inside labels do not count.
  const chain = (n: number) => 'graph LR\n' + Array.from({ length: n - 1 }, (_v, i) => `n${i} --> n${i + 1}`).join('\n')
  assert.equal(refuseMermaid(chain(150)), null)
  assert.equal(refuseMermaid(chain(160)), 'too many nodes')
  assert.equal(refuseMermaid('graph TD\n A["x & y & z & w & v"] --> B'), null)
  const t0 = Date.now()
  const runner = new MermaidRunner()
  assert.equal((await runner.run(dense(20), '#1e1e2e')).state, 'bad')
  runner.close()
  assert.ok(Date.now() - t0 < 200)
})

test('a conversion past the deadline is terminated, and the next one gets a fresh worker', async () => {
  const runner = new MermaidRunner()
  const t0 = Date.now()
  assert.equal((await runner.run(SUPPORTED.flowchartTD!, '#1e1e2e', 1)).state, 'timeout')
  assert.ok(Date.now() - t0 < 500)
  assert.equal((await runner.run(SUPPORTED.flowchartTD!, '#1e1e2e')).state, 'ok')
  runner.close()
})

test('close() ends a job in flight without calling it a failure', async () => {
  const runner = new MermaidRunner()
  const p = runner.run(SUPPORTED.er!, '#1e1e2e')
  const q = runner.run(SUPPORTED.state!, '#1e1e2e')
  runner.close()
  assert.equal((await p).state, 'closed')
  assert.equal((await q).state, 'closed')
  assert.equal((await runner.run(SUPPORTED.er!, '#1e1e2e')).state, 'ok')
  runner.close()
})

test('an idle worker does not keep the process alive', () => {
  const here = new URL('./mermaid.ts', import.meta.url).pathname
  const script = `import { MermaidRunner } from ${JSON.stringify(here)}
const hold = setTimeout(() => {}, 15000)
const r = await new MermaidRunner().run('graph TD\\n A --> B', '#1e1e2e')
clearTimeout(hold)
console.log(r.state)`
  const t0 = Date.now()
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000 })
  assert.equal(out.stdout.trim(), 'ok')
  assert.ok(Date.now() - t0 < 10_000)
})

test('flattenCssVars resolves var(), fallbacks and color-mix', () => {
  const svg =
    '<svg style="--bg:#000000;--fg:#ffffff"><style>svg{--_a:var(--fg);--_b:var(--nope, color-mix(in srgb, var(--fg) 50%, var(--bg)));}</style>' +
    '<rect fill="var(--_a)" stroke="var(--_b)" x="var(--missing, 3)"/></svg>'
  const out = flattenCssVars(svg)
  assert.match(out, /fill="#ffffff"/)
  assert.match(out, /stroke="#808080"/)
  assert.match(out, /x="3"/)
  assert.doesNotMatch(out, /var\(/)
})

test('only variables declared in style content count, not diagram text', () => {
  const svg =
    '<svg style="--bg:#000000;--fg:#ffffff"><rect fill="var(--fg)"/>' +
    '<text x="1">--fg: #ff0000</text><text>B["--fg: #ff0000;"]</text></svg>'
  assert.match(flattenCssVars(svg), /fill="#ffffff"/)
  assert.equal(flattenCssVars('<svg><text>--fg: #ff0000</text><rect fill="var(--fg, #123456)"/></svg>').includes('#123456'), true)
})
