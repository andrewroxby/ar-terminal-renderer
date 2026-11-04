-- Neovim bench body, run by bench/nvim.ts:
--   nvim --headless --noplugin -u NONE -i NONE -l bench/nvim.lua
-- Env: AR_BENCH_N formulas of each kind (default 20), TMPDIR for the cache.
-- Prints one JSON line: ms until every formula is drawn, the cost of a
-- rescan after an edit, and the cost of moving the cursor in insert mode.

local root = vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":p:h:h")
vim.opt.runtimepath:append(root .. "/nvim")
vim.o.swapfile = false
vim.o.shadafile = "NONE"
vim.o.termguicolors = true

local uv = vim.uv
local function ms()
  return uv.hrtime() / 1e6
end
local N = tonumber(vim.env.AR_BENCH_N) or 20
local seed = tonumber(vim.env.AR_BENCH_SEED) or 0

local lines = { "# Notes", "" }
for i = 1, N do
  local k = i + seed
  lines[#lines + 1] = string.format("Inline %d: let $a_{%d}^{2} + b_{%d}$ and $x_{%d} \\in \\mathbb{R}$ hold.", i, k, k, k)
  lines[#lines + 1] = ""
  lines[#lines + 1] = "$$"
  lines[#lines + 1] = string.format("\\int_0^{%d} x^{%d} e^{-x}\\,dx = \\sum_{j=0}^{%d} \\frac{a_j}{j!}", k + 2, k + 1, k + 1)
  lines[#lines + 1] = "$$"
  lines[#lines + 1] = ""
  lines[#lines + 1] = "Some prose between the formulas, enough to look like a note."
  lines[#lines + 1] = ""
end
-- Two inline spans per N; each display block has three line marks and an anchor.
local expected = 2 * N + 4 * N

local plugin = require("ar_term_render")
local queue = require("ar_term_render.queue")
local ns = vim.api.nvim_create_namespace("ar_term_render")
plugin.setup({ debounce = 50, resend = false })

local buf = vim.api.nvim_create_buf(true, false)
vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
vim.api.nvim_set_current_buf(buf)

local function marks()
  return #vim.api.nvim_buf_get_extmarks(buf, ns, 0, -1, {})
end

local t0 = ms()
vim.bo[buf].filetype = "markdown"
local ok = vim.wait(120000, function()
  local s = queue.stats()
  return marks() >= expected and s.running == 0 and s.pending == 0
end, 1)
local drawn = ms() - t0

local function stats(xs)
  table.sort(xs)
  return xs[math.ceil(#xs / 2)], xs[math.min(#xs, math.ceil(#xs * 0.95))]
end

-- Rescan after a one-character edit, everything already rendered.
local rescan = {}
for i = 1, 20 do
  local row = #lines - 1
  vim.api.nvim_buf_set_text(buf, row, 0, row, 0, { "x" })
  local a = ms()
  vim.cmd("ArRender render")
  rescan[#rescan + 1] = ms() - a
end

-- Cursor moves, as CursorMovedI fires on each line change while typing.
local cursor = {}
local win = vim.api.nvim_get_current_win()
for i = 1, 200 do
  vim.api.nvim_win_set_cursor(win, { (i * 7) % #lines + 1, 0 })
  local a = ms()
  vim.api.nvim_exec_autocmds("CursorMovedI", { buffer = buf })
  cursor[#cursor + 1] = ms() - a
end

local rm, rp = stats(rescan)
local cm, cp = stats(cursor)
print(vim.json.encode({ ok = ok, drawn_ms = drawn, marks = marks(), expected = expected, rescan_med = rm, rescan_p95 = rp, cursor_med = cm, cursor_p95 = cp }))
vim.cmd("qa!")
