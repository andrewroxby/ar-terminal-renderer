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

describe("graphics() under tmux", function()
  local saved, dir

  before_each(function()
    saved = { vim.env.AR_TERM_RENDER_IMAGES, vim.env.TMUX, vim.env.PATH, vim.o.termguicolors }
    dir = helpers.tmpdir()
    vim.env.AR_TERM_RENDER_IMAGES = nil
    vim.env.TMUX = "/tmp/x,1,0"
    vim.o.termguicolors = true
    vim.env.PATH = dir .. ":" .. saved[3]
    terminal.setup({ memo_ms = 0 })
  end)

  after_each(function()
    vim.env.AR_TERM_RENDER_IMAGES, vim.env.TMUX, vim.env.PATH, vim.o.termguicolors = saved[1], saved[2], saved[3], saved[4]
    terminal.setup()
    helpers.cleanup()
  end)

  -- A tmux that logs what it is asked and answers from a file.
  local function fake_tmux(viewer)
    local file = dir .. "/viewer"
    local f = assert(io.open(file, "w"))
    f:write(viewer)
    f:close()
    helpers.script(dir, "tmux", 'echo "$2" >> ' .. dir .. "/calls\ncat " .. file)
    return file
  end

  it("answers from memory once the memo is old, and learns the new answer without blocking", function()
    local file = fake_tmux("transport=local graphics=file")
    assert.is_true(terminal.graphics())
    assert.are.equal(1, #helpers.lines(dir .. "/calls"))

    local f = assert(io.open(file, "w"))
    f:write("transport=mosh graphics=no")
    f:close()
    assert.is_true(terminal.graphics(), "the old answer, at once")
    assert(vim.wait(5000, function()
      return not terminal.graphics()
    end, 10), "the background lookup should land")
  end)
end)

describe("graphics() lookups that overlap an invalidation", function()
  local saved, dir

  before_each(function()
    saved = { vim.env.AR_TERM_RENDER_IMAGES, vim.env.TMUX, vim.env.PATH, vim.o.termguicolors }
    dir = helpers.tmpdir()
    vim.env.AR_TERM_RENDER_IMAGES = nil
    vim.env.TMUX = "/tmp/x,1,0"
    vim.o.termguicolors = true
    vim.env.PATH = dir .. ":" .. saved[3]
    terminal.setup({ memo_ms = 0 })
  end)

  after_each(function()
    vim.env.AR_TERM_RENDER_IMAGES, vim.env.TMUX, vim.env.PATH, vim.o.termguicolors = saved[1], saved[2], saved[3], saved[4]
    terminal.setup()
    helpers.cleanup()
  end)

  local function set_viewer(text)
    local f = assert(io.open(dir .. "/viewer", "w"))
    f:write(text)
    f:close()
  end

  it("keeps the newer answer when an older background lookup lands after it", function()
    -- tmux reads its answer at once but, while `slow` exists, delivers it late.
    helpers.script(dir, "tmux", 'v=$(cat ' .. dir .. '/viewer)\n[ -e ' .. dir .. '/slow ] && sleep 0.4\necho "$v"')
    set_viewer("graphics=file")
    assert.is_true(terminal.graphics())

    set_viewer("graphics=no")
    vim.fn.writefile({}, dir .. "/slow")
    assert.is_true(terminal.graphics(), "the old answer, while the slow lookup runs")

    set_viewer("graphics=file")
    os.remove(dir .. "/slow")
    terminal.invalidate()
    assert.is_true(terminal.graphics(), "a direct lookup after the invalidation")

    vim.wait(800)
    assert.is_true(terminal.graphics(), "the stale lookup must not overwrite it")
  end)

  it("looks up a tmux client terminal in the background when the viewer line is silent", function()
    helpers.script(dir, "tmux", 'if [ "$1" = show ]; then exit 0; fi\necho xterm-ghostty')
    assert.is_true(terminal.graphics())
    helpers.script(dir, "tmux", 'if [ "$1" = show ]; then exit 0; fi\necho xterm-256color')
    assert.is_true(terminal.graphics())
    assert(vim.wait(5000, function()
      return not terminal.graphics()
    end, 10), "the two-step background lookup should land")
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
