-- Terminal spec: graphics detection against the vectors shared with the Pi
-- adapter (core/test/detect-vectors.json), and the writer's tmux wrapping.

local helpers = dofile(vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":h") .. "/helpers.lua")
local terminal = require("ar_term_render.terminal")

local function run_with(viewer, term)
  return function(_, args)
    if args[1] == "show" then
      return viewer
    end
    return term
  end
end

describe("graphics detection", function()
  local file = assert(io.open(helpers.root .. "/core/test/detect-vectors.json", "r"))
  local vectors = vim.json.decode(file:read("*a"))
  file:close()

  it("has the shared vectors", function()
    assert(#vectors > 10)
  end)

  for _, v in ipairs(vectors) do
    it(v.name, function()
      local run = run_with(v.viewer ~= vim.NIL and v.viewer or nil, v.term ~= vim.NIL and v.term or nil)
      assert.are.equal(v.ok, terminal.detect(v.env, run).ok)
    end)
  end

  it("also draws in herdr, which strips TMUX and draws kitty images itself", function()
    assert.is_true(terminal.detect({ TERM_PROGRAM = "herdr" }, run_with(nil, nil)).ok)
  end)
end)

describe("graphics()", function()
  local saved_images, saved_tmux, saved_termguicolors

  before_each(function()
    saved_images, saved_tmux, saved_termguicolors = vim.env.AR_TERM_RENDER_IMAGES, vim.env.TMUX, vim.o.termguicolors
    vim.env.TMUX = nil
    terminal.invalidate()
  end)

  after_each(function()
    vim.env.AR_TERM_RENDER_IMAGES, vim.env.TMUX, vim.o.termguicolors = saved_images, saved_tmux, saved_termguicolors
    terminal.invalidate()
  end)

  it("is false without termguicolors, since the image id cannot reach the terminal", function()
    vim.env.AR_TERM_RENDER_IMAGES = "1"
    vim.o.termguicolors = false
    assert.is_false(terminal.graphics())
    vim.o.termguicolors = true
    assert.is_true(terminal.graphics())
  end)

  it("honours AR_TERM_RENDER_IMAGES=0 and =1", function()
    vim.o.termguicolors = true
    vim.env.AR_TERM_RENDER_IMAGES = "0"
    assert.is_false(terminal.graphics())
    terminal.invalidate()
    vim.env.AR_TERM_RENDER_IMAGES = "1"
    assert.is_true(terminal.graphics())
  end)

  it("remembers its answer for a couple of seconds, until invalidated", function()
    vim.o.termguicolors = true
    vim.env.AR_TERM_RENDER_IMAGES = "1"
    assert.is_true(terminal.graphics())
    vim.env.AR_TERM_RENDER_IMAGES = "0"
    assert.is_true(terminal.graphics(), "still the earlier answer")
    terminal.invalidate()
    assert.is_false(terminal.graphics())
  end)
end)

describe("writing", function()
  local saved_tmux

  before_each(function()
    saved_tmux = vim.env.TMUX
  end)

  after_each(function()
    vim.env.TMUX = saved_tmux
  end)

  it("wraps for tmux passthrough with every ESC doubled", function()
    vim.env.TMUX = "/tmp/x,1,0"
    assert.are.equal("\027Ptmux;\027\027_Gq=2;AAAA\027\027\\\027\\", terminal.wrap("\027_Gq=2;AAAA\027\\"))
  end)

  it("leaves the bytes alone outside tmux", function()
    vim.env.TMUX = nil
    assert.are.equal("\027_Gq=2;AAAA\027\\", terminal.wrap("\027_Gq=2;AAAA\027\\"))
  end)
end)

describe("the cell size", function()
  after_each(function()
    terminal.setup()
  end)

  it("falls back to the configured size when the tty reports none", function()
    terminal.setup({ cell = { w = 7, h = 14 } })
    assert.are.same({ w = 7, h = 14 }, terminal.cell())
  end)
end)
