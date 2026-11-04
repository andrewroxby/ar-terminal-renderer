-- Render spec: whole-buffer behaviour end to end, against the real cellmath
-- and ar-term-render. Each group skips itself when its programs are absent.

local helpers = dofile(vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":h") .. "/helpers.lua")
local plugin = require("ar_term_render")
local image = require("ar_term_render.image")
local queue = require("ar_term_render.queue")
local terminal = require("ar_term_render.terminal")

local ns = vim.api.nvim_create_namespace("ar_term_render")
local PLACEHOLDER = vim.fn.nr2char(0x10EEEE)
local script = helpers.root .. "/core/cli.ts"

local have_cellmath = vim.fn.exepath("cellmath") ~= ""
local have_cli = vim.fn.exepath("ar-term-render") ~= ""
  or (vim.fn.exepath("node") ~= "" and vim.uv.fs_stat(script) ~= nil)
local have_rsvg = vim.fn.exepath("rsvg-convert") ~= ""

local function buffer_with(text)
  local buf = vim.api.nvim_create_buf(true, false)
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, vim.split(text, "\n", { plain = true }))
  vim.api.nvim_set_current_buf(buf)
  vim.bo[buf].filetype = "markdown"
  return buf
end

local function marks(buf)
  return vim.api.nvim_buf_get_extmarks(buf, ns, 0, -1, { details = true })
end

local function wait_for_marks(buf)
  local ok = vim.wait(5000, function()
    for _, m in ipairs(marks(buf)) do
      if m[4] and m[4].virt_text then
        return true
      end
    end
    return false
  end, 50)
  assert(ok, "expected decoration marks within 5s")
end

-- Waits until no renderer run is queued or running.
local function wait_for_idle()
  assert(vim.wait(10000, function()
    local stats = queue.stats()
    return stats.running == 0 and stats.pending == 0 and stats.keys == 0
  end, 20), "the render queue did not drain")
end

describe("setup", function()
  after_each(function()
    plugin.setup()
  end)

  it("can run twice without doubling its autocmds", function()
    plugin.setup()
    local once = #vim.api.nvim_get_autocmds({ group = "ar_term_render" })
    plugin.setup()
    plugin.setup({ resend_every = 500 })
    assert(once > 0)
    assert.are.equal(once, #vim.api.nvim_get_autocmds({ group = "ar_term_render" }))
  end)

  it("starts from the defaults each time", function()
    plugin.setup({ debounce = 1000 })
    plugin.setup({ images = false })
    assert.are.equal(300, plugin.config.debounce)
    assert.is_false(plugin.config.images)
  end)

  it("reaches the cell fallback, the renderer commands and the em sizes", function()
    plugin.setup({ fallback_cell = { w = 7, h = 14 } })
    assert.are.same({ w = 7, h = 14 }, terminal.cell())
    local notify = vim.notify
    vim.notify = function() end
    plugin.setup({ ar_term_render = "no-such-ar", node = "no-such-node" })
    local cmd = image.command()
    vim.notify = notify
    assert.is_nil(cmd)
  end)
end)

describe("the display indent", function()
  local saved = vim.env.AR_TERM_RENDER_MATH_INDENT

  after_each(function()
    vim.env.AR_TERM_RENDER_MATH_INDENT = saved
    plugin.setup()
  end)

  if have_cellmath then
    local function indent_of_drawn_block()
      plugin.setup({ images = false })
      local buf = buffer_with("$$x^2 + y^2$$")
      wait_for_marks(buf)
      local textoff = vim.fn.getwininfo(vim.api.nvim_get_current_win())[1].textoff
      for _, m in ipairs(marks(buf)) do
        if m[4].virt_text then
          return m[4].virt_text_win_col - textoff
        end
      end
    end

    it("is 3 columns, as in Pi", function()
      vim.env.AR_TERM_RENDER_MATH_INDENT = nil
      assert.are.equal(3, indent_of_drawn_block())
    end)

    it("follows AR_TERM_RENDER_MATH_INDENT (0-8) like Pi, and ignores anything else", function()
      vim.env.AR_TERM_RENDER_MATH_INDENT = "5"
      assert.are.equal(5, indent_of_drawn_block())
      vim.env.AR_TERM_RENDER_MATH_INDENT = "0"
      assert.are.equal(0, indent_of_drawn_block())
      for _, bad in ipairs({ "9", "-1", "2.5", "x", "" }) do
        vim.env.AR_TERM_RENDER_MATH_INDENT = bad
        assert.are.equal(3, indent_of_drawn_block(), bad)
      end
    end)
  end
end)

if have_cellmath then
  describe("cellmath art", function()
    before_each(function()
      plugin.setup({ images = false })
    end)

    it("covers a $$ block with art rows", function()
      local buf = buffer_with("before\n$$\\frac{1}{2}$$\nafter")
      wait_for_marks(buf)
      local found = false
      for _, m in ipairs(marks(buf)) do
        local vt = m[4] and m[4].virt_text
        if vt and vt[1] and vt[1][1]:find("1") then
          found = true
        end
      end
      assert(found, "expected an overlay mark carrying the rendered fraction")
    end)

    it("replaces an inline span with one-row art", function()
      local buf = buffer_with("So $x^2$ works.")
      wait_for_marks(buf)
      local found = false
      for _, m in ipairs(marks(buf)) do
        local d = m[4]
        if d and d.virt_text_pos == "inline" and d.virt_text[1][1] == "x²" then
          found = true
        end
      end
      assert(found, "expected an inline mark with the rendered superscript")
    end)

    it("leaves display math wider than the window as source", function()
      local wide = ("a + "):rep(60) .. "b"
      local buf = buffer_with("$$" .. wide .. "$$\n\n$$x^2$$")
      assert(#wide > vim.api.nvim_win_get_width(0), "the formula must be wider than the window")
      -- The short block draws, and once every queued run has answered the
      -- wide one has had its turn.
      wait_for_marks(buf)
      wait_for_idle()
      for _, m in ipairs(marks(buf)) do
        if m[4].virt_text then
          assert(m[2] == 2, "only the short block (row 2) may be drawn, got a mark on row " .. m[2])
        end
      end
    end)
  end)

  describe("undrawable math", function()
    local dir, image_runs, art_runs, saved_termguicolors

    before_each(function()
      dir = helpers.tmpdir()
      image_runs, art_runs = dir .. "/image", dir .. "/art"
      local node = helpers.script(dir, "node", "echo v26.0.0")
      local ar = helpers.script(dir, "ar", "echo x >> " .. image_runs .. '\necho "ar-term-render: could not typeset that LaTeX" >&2\nexit 1')
      local cellmath = helpers.script(dir, "cellmath", "echo x >> " .. art_runs .. "\nexec " .. vim.fn.exepath("cellmath") .. ' "$@"')
      saved_termguicolors = vim.o.termguicolors
      vim.o.termguicolors = true
      vim.env.AR_TERM_RENDER_IMAGES = "1"
      terminal.invalidate()
      plugin.setup({ ar_term_render = ar, node = node, cellmath = cellmath, persistent = false })
    end)

    after_each(function()
      vim.env.AR_TERM_RENDER_IMAGES = nil
      vim.o.termguicolors = saved_termguicolors
      terminal.invalidate()
      plugin.setup()
      helpers.cleanup()
    end)

    it("is asked about once, not on every buffer that holds it", function()
      local first = buffer_with("$$\\frac{1}{$$")
      wait_for_idle()
      assert.are.equal(1, #helpers.lines(image_runs))
      assert.are.equal(1, #helpers.lines(art_runs))
      local function drawn(buf)
        return vim.tbl_filter(function(m)
          return m[4].virt_text ~= nil
        end, marks(buf))
      end
      assert.are.same({}, drawn(first), "nothing is drawn for it")
      local second = buffer_with("again\n\n$$\\frac{1}{$$")
      vim.wait(300)
      wait_for_idle()
      assert.are.equal(1, #helpers.lines(image_runs))
      assert.are.equal(1, #helpers.lines(art_runs))
      assert.are.same({}, drawn(second))
    end)
  end)
end

if have_cli and have_rsvg then
  describe("kitty images", function()
    local saved_termguicolors, saved_tmpdir

    before_each(function()
      saved_termguicolors, saved_tmpdir = vim.o.termguicolors, vim.env.TMPDIR
      vim.o.termguicolors = true
      vim.env.AR_TERM_RENDER_IMAGES = "1"
      vim.env.TMPDIR = helpers.tmpdir()
      plugin.setup({ images = true, fallback_cell = { w = 16, h = 32 } })
    end)

    after_each(function()
      vim.env.AR_TERM_RENDER_IMAGES = nil
      vim.o.termguicolors = saved_termguicolors
      vim.env.TMPDIR = saved_tmpdir
      plugin.setup()
      helpers.cleanup()
    end)

    local function image_hl(buf)
      for _, m in ipairs(marks(buf)) do
        local details = m[4]
        local vt = details and details.virt_text
        if vt and vt[1] and vt[1][1]:find(PLACEHOLDER, 1, true) then
          return vt[1][2], details.virt_text_win_col
        end
      end
    end

    it("draws a $$ block as placeholder rows carrying an image id", function()
      local buf = buffer_with("before\n$$\\frac{1}{2}$$\nafter")
      wait_for_marks(buf)
      local hl, win_col = image_hl(buf)
      assert(hl, "expected an overlay mark of placeholder cells")
      local textoff = vim.fn.getwininfo(vim.api.nvim_get_current_win())[1].textoff
      assert.are.equal(textoff + plugin.config.display_indent, win_col, "display math sits at the indent")
      assert(hl:match("^ArRenderImage%d+$"), "expected the image highlight group, got " .. tostring(hl))
    end)

    it("keeps inline images to a single row", function()
      local buf = buffer_with("So $x^2$ works.")
      wait_for_marks(buf)
      local found = false
      for _, m in ipairs(marks(buf)) do
        local d = m[4]
        if d and d.virt_text_pos == "inline" and d.virt_text[1][1]:find(PLACEHOLDER, 1, true) then
          found = true
          assert(not d.virt_lines, "an inline span must not add virtual lines")
        end
      end
      assert(found, "expected an inline mark of placeholder cells")
    end)

    it("draws no images without termguicolors", function()
      vim.o.termguicolors = false
      terminal.invalidate()
      local buf = buffer_with("$$\\alpha$$")
      wait_for_idle()
      vim.wait(300)
      assert.is_nil(image_hl(buf))
    end)

    it("keeps the picture when :colorscheme clears the image highlight groups", function()
      local buf = buffer_with("before\n$$\\frac{1}{2}$$\nafter")
      wait_for_marks(buf)
      local hl = image_hl(buf)
      local id = tonumber(hl:match("%d+$"))
      assert.are.equal(id, vim.api.nvim_get_hl(0, { name = hl, link = false }).fg)

      vim.cmd("colorscheme default")

      -- The ColorScheme handler restores the group at once.
      assert.are.equal(id, vim.api.nvim_get_hl(0, { name = hl, link = false }).fg, "the id must survive :colorscheme")
      assert.are.equal(id, vim.api.nvim_get_hl(0, { name = hl, link = false }).sp)
      -- And the buffer redraws, in a group that still carries an id.
      vim.wait(800, function()
        return false
      end)
      wait_for_marks(buf)
      local now = image_hl(buf)
      assert(now, "the block is still drawn as an image")
      assert.is_not_nil(vim.api.nvim_get_hl(0, { name = now, link = false }).fg)
    end)

    describe("the resend backstop", function()
      local resends, original

      before_each(function()
        resends = 0
        original = image.resend
        image.resend = function(wanted)
          resends = resends + 1
          return original(wanted)
        end
        plugin.setup({ images = true, fallback_cell = { w = 16, h = 32 }, resend_every = 80 })
      end)

      after_each(function()
        image.resend = original
        plugin.setup()
      end)

      it("pauses while the terminal reports Neovim unfocused, and resumes on focus", function()
        local buf = buffer_with("$$\\alpha$$")
        wait_for_marks(buf)
        assert(vim.wait(2000, function()
          return resends >= 2
        end, 20), "the backstop should be running")

        vim.api.nvim_exec_autocmds("FocusLost", {})
        vim.wait(150)
        local paused_at = resends
        vim.wait(600)
        assert.are.equal(paused_at, resends, "no backstop uploads while unfocused")

        vim.api.nvim_exec_autocmds("FocusGained", {})
        vim.wait(700)
        assert(resends >= paused_at + 4, "the backstop should run again once focused (" .. (resends - paused_at) .. " more)")
      end)
    end)
  end)
end
