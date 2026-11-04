-- ar_term_render.terminal: what the terminal can do and how to talk to it.
-- The cell size in pixels, whether it draws kitty graphics, and a raw-byte
-- writer that is safe under tmux.

local api = vim.api
local uv = vim.uv

local M = {}

local defaults = {
  -- Cell size when the ioctl probe fails; Ghostty at RobotoMono 15.
  cell = { w = 9, h = 20 },
  -- How long a graphics answer is kept before it is looked up again.
  memo_ms = 2000,
}

local config = vim.deepcopy(defaults)

--- Replaces the options with the defaults plus `opts`, so calling it again
--- starts from scratch.
--- @param opts table|nil { cell = { w, h }, memo_ms = number }
function M.setup(opts)
  config = vim.tbl_deep_extend("force", vim.deepcopy(defaults), opts or {})
  M.invalidate_cell()
  M.invalidate()
end

local cell_cache = nil

-- Real pixels per cell, straight from the tty. Neovim exposes no API for
-- this, and a CSI 16t query cannot be read back reliably under tmux with
-- extended-keys on, so ask the kernel.
local function probe_cell()
  local ok, ffi = pcall(require, "ffi")
  if not ok then
    return nil
  end
  local declared = pcall(ffi.cdef, [[
    typedef struct { unsigned short ws_row, ws_col, ws_xpixel, ws_ypixel; } ar_term_render_winsize;
    int ioctl(int, unsigned long, ...);
  ]])
  if not declared and not pcall(ffi.typeof, "ar_term_render_winsize") then
    return nil
  end
  local size = ffi.new("ar_term_render_winsize")
  -- TIOCGWINSZ: 0x40087468 on macOS/BSD, 0x5413 on Linux.
  local request = vim.fn.has("mac") == 1 and 0x40087468 or 0x5413
  if ffi.C.ioctl(1, request, size) ~= 0 then
    return nil
  end
  if size.ws_xpixel == 0 or size.ws_ypixel == 0 or size.ws_col == 0 or size.ws_row == 0 then
    return nil
  end
  return {
    w = math.floor(size.ws_xpixel / size.ws_col),
    h = math.floor(size.ws_ypixel / size.ws_row),
  }
end

function M.cell()
  if not cell_cache then
    cell_cache = probe_cell() or config.cell
  end
  return cell_cache
end

function M.invalidate_cell()
  cell_cache = nil
end

-- ---- graphics ----

local KITTY_TERMS = { "ghostty", "kitty", "wezterm" }

local function mentions_kitty_term(s)
  s = s:lower()
  for _, t in ipairs(KITTY_TERMS) do
    if s:find(t, 1, true) then
      return true
    end
  end
  return false
end

-- Runs a command and answers its trimmed stdout, or nil when it fails.
local function default_run(cmd, args)
  local ok, res = pcall(function()
    return vim.system(vim.list_extend({ cmd }, args), { text = true }):wait(1500)
  end)
  if ok and res.code == 0 and res.stdout then
    return vim.trim(res.stdout)
  end
  return nil
end

--- Whether a terminal draws kitty graphics, by the same rules as
--- core/env.ts (the shared vectors in core/test/detect-vectors.json hold
--- both to them):
---   AR_TERM_RENDER_IMAGES=0|1 decides outright. Under tmux, the @viewer
---   line decides when it names transport=none or a graphics value, else the
---   attached client's terminal does. Outside tmux, the kitty and Ghostty
---   environment does.
--- herdr draws kitty images itself and strips TMUX, so TERM_PROGRAM=herdr
--- counts here (and only here).
--- @param env table environment variables by name
--- @param run fun(cmd: string, args: string[]): string|nil
--- @return table { ok: boolean, reason: string }
function M.detect(env, run)
  local override = env.AR_TERM_RENDER_IMAGES
  if override == "0" then
    return { ok = false, reason = "AR_TERM_RENDER_IMAGES=0" }
  elseif override == "1" then
    return { ok = true, reason = "AR_TERM_RENDER_IMAGES=1" }
  end

  if env.TMUX and env.TMUX ~= "" then
    local viewer = run("tmux", { "show", "-gv", "@viewer" })
    if viewer and viewer ~= "" then
      local kv = {}
      for part in viewer:gmatch("%S+") do
        local k, v = part:match("^([^=]*)=(.*)$")
        kv[k or part] = v or ""
      end
      if kv.transport == "none" then
        return { ok = false, reason = "no viewer attached" }
      elseif kv.graphics == "file" or kv.graphics == "inline" then
        return { ok = true, reason = "viewer graphics=" .. kv.graphics }
      elseif kv.graphics == "no" then
        return { ok = false, reason = "viewer graphics=no" }
      end
    end
    local term = (run("tmux", { "display", "-p", "#{client_termname}" }) or ""):lower()
    return { ok = mentions_kitty_term(term), reason = "tmux client " .. (term ~= "" and term or "unknown") }
  end

  local ok = env.KITTY_WINDOW_ID ~= nil
    or env.GHOSTTY_RESOURCES_DIR ~= nil
    or mentions_kitty_term((env.TERM or "") .. " " .. (env.TERM_PROGRAM or ""))
    or (env.TERM_PROGRAM or ""):lower() == "herdr"
  return { ok = ok, reason = ok and "kitty-graphics terminal" or "terminal not recognized" }
end

local memo = nil
local refreshing = false

local function now_ms()
  return uv.hrtime() / 1e6
end

function M.invalidate()
  memo = nil
end

-- `detect` again with commands that wait on the event loop instead of
-- blocking it, so a tmux that answers slowly cannot stall the editor. The
-- detection reads like straight-line code; each command yields until its
-- answer arrives.
local function refresh_async()
  if refreshing then
    return
  end
  refreshing = true
  local co
  local function run(cmd, args)
    local ok = pcall(vim.system, vim.list_extend({ cmd }, args), { text = true }, function(res)
      vim.schedule(function()
        coroutine.resume(co, res.code == 0 and res.stdout and vim.trim(res.stdout) or nil)
      end)
    end)
    if not ok then
      return nil
    end
    return coroutine.yield()
  end
  co = coroutine.create(function()
    local ok, res = pcall(M.detect, vim.env, run)
    refreshing = false
    if ok and memo then
      memo = { at = now_ms(), v = res.ok }
    end
  end)
  coroutine.resume(co)
end

--- Whether to draw images now. Placeholder cells carry the image id in a
--- 24-bit foreground colour, which a terminal only gets with termguicolors.
--- The first answer comes straight from the environment and tmux. After
--- memo_ms the old answer is returned at once while a fresh one is fetched in
--- the background.
function M.graphics()
  if not vim.o.termguicolors then
    return false
  end
  local t = now_ms()
  if not memo then
    memo = { at = t, v = M.detect(vim.env, default_run).ok }
  elseif t - memo.at > config.memo_ms then
    refresh_async()
  end
  return memo.v
end

-- ---- writing ----

--- Wraps an escape sequence for tmux passthrough when running under tmux.
function M.wrap(data)
  if vim.env.TMUX then
    return "\027Ptmux;" .. data:gsub("\027", "\027\027") .. "\027\\"
  end
  return data
end

--- Sends bytes to the terminal as they are, in one write. Headless runs have
--- no UI to draw on, so the bytes are dropped.
function M.send(data)
  if #api.nvim_list_uis() == 0 then
    return
  end
  if api.nvim_ui_send then
    pcall(api.nvim_ui_send, data)
  else
    io.stdout:write(data)
  end
end

--- Wraps for tmux when needed, then sends.
function M.write(data)
  M.send(M.wrap(data))
end

return M
