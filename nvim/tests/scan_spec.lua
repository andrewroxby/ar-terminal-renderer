-- Scanner spec: pure-function coverage of ar_term_render.scan over the shapes math
-- actually takes in Andrew's vault prose, plus the false-positive guards.

local scan = require("ar_term_render.scan").scan

local function lines(text)
  return vim.split(text, "\n", { plain = true })
end

describe("scan", function()
  it("finds a multi-line $$ block and covers its fence lines", function()
    local displays, inlines = scan(lines("before\n$$\nx = 1\n$$\nafter"))
    assert.are.same(1, #displays)
    assert.are.same({ open = 1, close = 3, body = "x = 1" }, displays[1])
    assert.are.same(0, #inlines)
  end)

  it("finds a single-line $$...$$ block", function()
    local displays = scan(lines("intro\n$$x = 1$$\noutro"))
    assert.are.same({ open = 1, close = 1, body = "x = 1" }, displays[1])
  end)

  it("finds a \\[ \\] block", function()
    local displays = scan(lines("\\[\n\\sum_{i=1}^{n} i\n\\]"))
    assert.are.same({ open = 0, close = 2, body = "\\sum_{i=1}^{n} i" }, displays[1])
  end)

  it("leaves an unclosed $$ block alone", function()
    local displays = scan(lines("$$\nnever closed"))
    assert.are.same(0, #displays)
  end)

  it("leaves a $$ or \\[ block with a blank line inside alone, as Pi does", function()
    assert.are.same(0, #scan(lines("$$\na\n\nb\n$$")))
    assert.are.same(0, #scan(lines("\\[\na\n\nb\n\\]")))
    assert.are.same(0, #scan(lines("$$\na\n  \nb\n$$")))
    -- A block after the refused one still draws.
    local displays = scan(lines("$$\na\n\nb\n\n$$\nc\n$$"))
    assert.are.same(1, #displays)
    assert.are.same("c", displays[1].body)
  end)

  it("keeps scanning after malformed display openers", function()
    local displays, inlines = scan(lines("$$\nunclosed\nLater $x$ works"))
    assert.are.same(0, #displays)
    assert.are.same(1, #inlines)
    assert.are.same("x", inlines[1].body)
  end)

  it("skips math-looking text inside code fences", function()
    local displays, inlines = scan(lines("```\n$$x$$\n```\n\n$y = 2$"))
    assert.are.same(0, #displays)
    assert.are.same(1, #inlines)
    assert.are.same(4, inlines[1].row)
  end)

  it("finds inline $...$ with 0-based buffer columns", function()
    local _, inlines = scan(lines("So $x^2$ works."))
    assert.are.same({ row = 0, s = 3, e = 8, body = "x^2" }, inlines[1])
  end)

  it("does not treat currency as math", function()
    local _, inlines = scan(lines("It costs $5 and then $10 more."))
    assert.are.same(0, #inlines)
  end)

  it("does not let currency swallow a real formula later on the line", function()
    local _, inlines = scan(lines("It costs $5 and then $x$ more."))
    assert.are.same(1, #inlines)
    assert.are.same("x", inlines[1].body)
  end)

  it("does not match a $ followed by a space", function()
    local _, inlines = scan(lines("a $ notmath $ b"))
    assert.are.same(0, #inlines)
  end)

  it("skips inline code spans", function()
    local _, inlines = scan(lines("`$x$` and $y$"))
    assert.are.same(1, #inlines)
    assert.are.same("y", inlines[1].body)
  end)

  it("finds \\( \\) inline spans", function()
    local _, inlines = scan(lines("Euler \\( e^{i\\pi} + 1 = 0 \\) done"))
    assert.are.same(1, #inlines)
    assert.are.same(" e^{i\\pi} + 1 = 0 ", inlines[1].body)
  end)

  it("handles several inline spans on one line", function()
    local _, inlines = scan(lines("$a$ plus $b$"))
    assert.are.same(2, #inlines)
    assert.are.same("a", inlines[1].body)
    assert.are.same("b", inlines[2].body)
  end)

  it("treats a ```math fence as display math", function()
    local displays, inlines = scan(lines("intro\n```math\nx = y\n```\nafter"))
    assert.are.same(1, #displays)
    assert.are.same("x = y", displays[1].body)
    -- The fence lines belong to the block, so it collapses to pure render.
    assert.are.same(1, displays[1].open)
    assert.are.same(3, displays[1].close)
    assert.are.same(0, #inlines)
  end)

  it("leaves other fenced languages alone", function()
    local displays, inlines = scan(lines("```lua\nlocal x = '$y$'\n```"))
    assert.are.same(0, #displays)
    assert.are.same(0, #inlines)
  end)

  it("ignores an unclosed ```math fence", function()
    local displays = scan(lines("```math\nx = y"))
    assert.are.same(0, #displays)
  end)

  -- render-markdown sizes table cells from widths it tracks itself, so a
  -- replacement it cannot see would misalign the table.
  it("leaves math inside table rows as source", function()
    local _, inlines = scan(lines("| col | val |\n| --- | --- |\n| a | $x^2$ |"))
    assert.are.same(0, #inlines)
  end)

  it("still renders math on the line after a table", function()
    local _, inlines = scan(lines("| a | b |\n\nAfter $y$ here"))
    assert.are.same(1, #inlines)
    assert.are.same("y", inlines[1].body)
  end)
end)
