-- Art spec: ar_term_render.art against the real cellmath CLI. Skips itself
-- when cellmath is absent.

local art = require("ar_term_render.art")

if vim.fn.exepath(art.config.bin) == "" then
  return
end

local function draw(expr, inline)
  local done, result = false, nil
  art.render(expr, inline, function(rows)
    result = rows
    done = true
  end)
  assert(vim.wait(5000, function()
    return done
  end, 50), "art did not finish")
  return result
end

describe("art", function()
  it("draws a display fraction over several rows, without styling", function()
    local rows = draw([[\frac{a+b}{2}]], false)
    assert.are.same({ "a+b", "───", " 2" }, rows)
  end)

  it("draws inline math as one flat row", function()
    assert.are.same({ "(a+b)/2" }, draw([[\frac{a+b}{2}]], true))
    assert.are.same({ "x²" }, draw("x^2", true))
  end)

  it("takes an expression that starts like a flag", function()
    assert.are.same({ "-x" }, draw("-x", false))
  end)

  it("refuses inline math that needs more than one row", function()
    assert.is_nil(draw([[\begin{pmatrix} a & b \\ c & d \end{pmatrix}]], true))
  end)

  it("answers nil for TeX it cannot typeset", function()
    assert.is_nil(draw([[\frac{1}{]], false))
  end)
end)
