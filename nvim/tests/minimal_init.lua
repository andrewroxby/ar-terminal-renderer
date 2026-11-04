-- Minimal init for headless plenary test runs.
-- Puts this plugin and plenary.nvim on the runtimepath, nothing else.

-- Spec files run as parallel headless nvim jobs. Nothing headless ever wants a
-- swapfile, and later phases will open real buffers, so turn them off now.
vim.o.swapfile = false

-- No ShaDa either, and this one matters beyond tidiness. Neovim saves session
-- state by writing `main.shada.tmp.X` and renaming it over `main.shada`; a
-- process that dies before the rename orphans its temp file. A directory run
-- spawns one nvim per spec file, so a single `make test` can strand a handful.
-- There are only 26 letters available, and once all 26 exist Neovim cannot
-- write ShaDa at all and every session ends with E138. Test runs have no
-- session state worth keeping, so they write none.
vim.o.shadafile = "NONE"

local function add_to_rtp(path)
  if path and vim.uv.fs_stat(path) then
    vim.opt.runtimepath:append(path)
    return true
  end
  return false
end

-- This plugin: tests/ -> repo root.
local here = debug.getinfo(1, "S").source:sub(2)
add_to_rtp(vim.fn.fnamemodify(here, ":h:h"))

-- plenary.nvim — try the usual install locations, then give up loudly. One of
-- these must succeed or PlenaryBustedDirectory won't exist.
local data = vim.fn.stdpath("data")
local candidates = {
  data .. "/lazy/plenary.nvim",
  data .. "/site/pack/packer/start/plenary.nvim",
  data .. "/site/pack/vendor/start/plenary.nvim",
  vim.fn.expand("~/.local/share/nvim/lazy/plenary.nvim"),
}
local found = false
for _, c in ipairs(candidates) do
  if add_to_rtp(c) then
    found = true
    break
  end
end
if not found then
  error("plenary.nvim not found on this machine; add its path in tests/minimal_init.lua")
end

-- render-markdown, for the integration spec only. Its absence is not fatal:
-- that spec skips itself rather than failing the suite.
add_to_rtp(data .. "/lazy/render-markdown.nvim")

vim.cmd("runtime plugin/plenary.vim")
