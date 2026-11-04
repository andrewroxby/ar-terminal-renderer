-- Render spec: whole-buffer behaviour end to end, against the real cellmath
-- and ar-term-render. Each group skips itself when its programs are absent,
-- the way scholia's integration spec skips without render-markdown.

local plugin = require("ar_term_render")
local image = require("ar_term_render.image")
local terminal = require("ar_term_render.terminal")

local ns = vim.api.nvim_create_namespace("ar_term_render")
local PLACEHOLDER = vim.fn.nr2char(0x10EEEE)

local have_cellmath = vim.fn.exepath("cellmath") ~= ""
local have_cli = vim.fn.exepath("ar-term-render") ~= ""
  or (vim.fn.exepath("node") ~= "" and vim.uv.fs_stat(image.config.ar_fallback_script) ~= nil)
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
      -- The short block renders after the wide one, so its marks prove the
      -- wide one has had its turn.
      wait_for_marks(buf)
      vim.wait(500)
      for _, m in ipairs(marks(buf)) do
        if m[4].virt_text then
          assert(m[2] == 2, "only the short block (row 2) may be drawn, got a mark on row " .. m[2])
        end
      end
    end)
  end)
end

if have_cli and have_rsvg and terminal.graphics() then
  describe("kitty images", function()
    before_each(function()
      terminal.config.cell = { w = 16, h = 32 }
      terminal.invalidate_cell()
      plugin.setup({ images = true })
    end)

    after_each(function()
      terminal.config.cell = { w = 9, h = 20 }
      terminal.invalidate_cell()
    end)

    it("draws a $$ block as placeholder rows carrying an image id", function()
      local buf = buffer_with("before\n$$\\frac{1}{2}$$\nafter")
      wait_for_marks(buf)
      local hl, win_col
      for _, m in ipairs(marks(buf)) do
        local details = m[4]
        local vt = details and details.virt_text
        if vt and vt[1] and vt[1][1]:find(PLACEHOLDER, 1, true) then
          hl = vt[1][2]
          win_col = details.virt_text_win_col
        end
      end
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
  end)
end
