-- Shared by the specs: scratch directories and small shell scripts that stand
-- in for the renderer or cellmath.

local M = {}

-- tests/ -> nvim/ -> checkout root.
M.root = vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":h:h:h")

--- A fresh directory, removed by M.cleanup().
local made = {}
function M.tmpdir()
  local dir = vim.fn.tempname()
  vim.fn.mkdir(dir, "p")
  made[#made + 1] = dir
  return dir
end

function M.cleanup()
  for _, dir in ipairs(made) do
    vim.fn.delete(dir, "rf")
  end
  made = {}
end

--- Writes an executable `sh` script and answers its path.
function M.script(dir, name, body)
  local path = dir .. "/" .. name
  local file = assert(io.open(path, "w"))
  file:write("#!/bin/sh\n" .. body .. "\n")
  file:close()
  vim.uv.fs_chmod(path, 493)
  return path
end

--- The lines of a text file, empty when it is missing.
function M.lines(path)
  local file = io.open(path, "r")
  if not file then
    return {}
  end
  local out = {}
  for line in file:lines() do
    out[#out + 1] = line
  end
  file:close()
  return out
end

return M
