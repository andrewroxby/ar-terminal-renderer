-- ar_term_render.lock: the cross-process lock for kitty transmissions, the
-- Lua side of core/lock.ts. Continuation chunks carry no image id, so two
-- processes writing to one terminal at once would splice their chunks
-- together. Both sides take the same directory, `transmit.lock` in the
-- renderer's cache directory, created with mkdir, and steal it once it is
-- older than STALE_MS. This side never waits: a busy lock means "try again
-- shortly", because blocking would freeze the editor.

local uv = vim.uv

local M = {}

local STALE_MS = 3000

--- The renderer's cache directory, `ar-term-render` under $TMPDIR, the same
--- one core/raster.ts's defaultCacheDir() names.
function M.dir()
  local base = "/tmp"
  for _, name in ipairs({ "TMPDIR", "TMP", "TEMP" }) do
    local v = vim.env[name]
    if v and v ~= "" then
      base = v
      break
    end
  end
  return (base:gsub("/+$", "")) .. "/ar-term-render"
end

local function mtime_ms(stat)
  return stat.mtime.sec * 1000 + stat.mtime.nsec / 1e6
end

local function now_ms()
  local sec, usec = uv.gettimeofday()
  return sec * 1000 + usec / 1000
end

--- Takes the lock if it is free, or stale. Answers a release function, or
--- nil when another process holds it (or the directory cannot be made).
--- @param dir string|nil cache directory, default M.dir()
--- @return fun()|nil
function M.try(dir)
  dir = dir or M.dir()
  if not pcall(vim.fn.mkdir, dir, "p") then
    return nil
  end
  local lock = dir .. "/transmit.lock"
  -- A few rounds cover a stale lock stolen from under a racing taker.
  for _ = 1, 4 do
    local ok, _, code = uv.fs_mkdir(lock, 448)
    if ok then
      return function()
        uv.fs_rmdir(lock)
      end
    end
    if code ~= "EEXIST" then
      return nil
    end
    local stat = uv.fs_stat(lock)
    if stat then
      if now_ms() - mtime_ms(stat) <= STALE_MS then
        return nil
      end
      uv.fs_rmdir(lock)
    end
  end
  return nil
end

return M
