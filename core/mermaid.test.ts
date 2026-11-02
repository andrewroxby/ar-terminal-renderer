import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mermaidToSvg } from './mermaid.ts'
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

test('supported diagram types render to svg with no CSS variables left', () => {
  for (const [name, src] of Object.entries(SUPPORTED)) {
    const m = mermaidToSvg(src, '#1e1e2e')
    assert.ok(m, name)
    assert.ok(m!.vw > 0 && m!.vh > 0, name)
    assert.doesNotMatch(m!.svg, /var\(--/, name)
    assert.doesNotMatch(m!.svg, /@import|googleapis|font-family:\s*'/, name)
  }
})

test('supported diagrams rasterize', { skip: hasRsvg ? false : 'rsvg missing' }, () => {
  for (const [name, src] of Object.entries(SUPPORTED)) {
    const m = mermaidToSvg(src, '#1e1e2e')!
    assert.equal(spawnSync('rsvg-convert', ['-f', 'png', '-w', '200'], { input: m.svg }).status, 0, name)
  }
})

test('unsupported types and junk are refused, so Pi draws the fence', () => {
  for (const src of ['pie title Pets\n "Dogs" : 386', 'gantt\n title A', 'journey\n title x', 'mindmap\n root((x))', 'hello world', '']) {
    assert.equal(mermaidToSvg(src, '#1e1e2e'), null, src)
  }
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
