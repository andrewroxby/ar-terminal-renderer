-- Art spec: ar_term_render.art against the real cellmath CLI. Skips itself
-- when cellmath is absent.

local helpers = dofile(vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":h") .. "/helpers.lua")
local art = require("ar_term_render.art")

if vim.fn.exepath("cellmath") == "" then
  return
end

-- Answers the rows and the transient flag.
local function draw(expr, inline)
  local done, result, transient = false, nil, nil
  art.render(expr, inline, function(rows, t)
    result, transient = rows, t
    done = true
  end)
  assert(vim.wait(5000, function()
    return done
  end, 50), "art did not finish")
  return result, transient
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

describe("art, with a stand-in cellmath", function()
  local dir, ran

  before_each(function()
    dir = helpers.tmpdir()
    ran = dir .. "/ran"
  end)

  after_each(function()
    art.setup()
    helpers.cleanup()
  end)

  it("remembers an expression cellmath rejects, and does not run it again", function()
    art.setup({ bin = helpers.script(dir, "cellmath", "echo x >> " .. ran .. "\necho 'cellmath: cannot render' >&2\nexit 1") })
    local rows, transient = draw([[\badone]], false)
    assert.is_nil(rows)
    assert.is_nil(transient)
    draw([[\badone]], false)
    assert.are.equal(1, #helpers.lines(ran))
  end)

  it("does not remember a run that failed outright", function()
    art.setup({ bin = helpers.script(dir, "cellmath", "echo x >> " .. ran .. "\nexit 70") })
    local rows, transient = draw([[x^2]], false)
    assert.is_nil(rows)
    assert.is_true(transient)
    draw([[x^2]], false)
    assert.are.equal(2, #helpers.lines(ran))
  end)

  it("does not remember a missing cellmath", function()
    local notify = vim.notify
    vim.notify = function() end
    art.setup({ bin = "no-such-cellmath" })
    local rows, transient = draw([[x^2]], false)
    vim.notify = notify
    assert.is_nil(rows)
    assert.is_true(transient)
  end)
end)
