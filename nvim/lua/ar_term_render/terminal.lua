-- ar_term_render.terminal: what the terminal can do and how to talk to it.
-- The cell size in pixels, whether it draws kitty graphics, and a raw-byte
-- writer that is safe under tmux.

local api = vim.api

local M = {}

M.config = {
  -- Cell size when the ioctl probe fails; Ghostty at RobotoMono 15.
  cell = { w = 9, h = 20 },
}

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
    cell_cache = probe_cell() or M.config.cell
  end
  return cell_cache
end

function M.invalidate_cell()
  cell_cache = nil
end

local tmux_term = nil

-- The outer client's terminal name; inside tmux $TERM only says tmux-256color.
function M.tmux_client_term()
  if tmux_term == nil then
    local out = vim.fn.system({ "tmux", "display-message", "-p", "#{client_termname}" })
    tmux_term = vim.v.shell_error == 0 and vim.trim(out):lower() or ""
  end
  return tmux_term
end

--- Whether to draw images. $AR_TERM_RENDER_IMAGES=0 turns them off.
function M.graphics()
  if vim.env.AR_TERM_RENDER_IMAGES == "0" then
    return false
  end
  local term = (vim.env.TERM or ""):lower()
  local program = (vim.env.TERM_PROGRAM or ""):lower()
  return vim.env.KITTY_WINDOW_ID ~= nil
    or vim.env.GHOSTTY_RESOURCES_DIR ~= nil
    or program == "kitty"
    or program == "ghostty"
    -- herdr draws kitty images itself and strips TMUX, so no passthrough.
    or program == "herdr"
    or term:find("kitty", 1, true) ~= nil
    or term:find("ghostty", 1, true) ~= nil
    or (vim.env.TMUX ~= nil and M.tmux_client_term():find("ghostty", 1, true) ~= nil)
    or (vim.env.TMUX ~= nil and M.tmux_client_term():find("kitty", 1, true) ~= nil)
end

--- Writes raw bytes to the terminal, wrapped for tmux passthrough when
--- needed. Headless runs have no UI to draw on, so the bytes are dropped.
function M.write(data)
  if #api.nvim_list_uis() == 0 then
    return
  end
  if vim.env.TMUX then
    data = "\027Ptmux;" .. data:gsub("\027", "\027\027") .. "\027\\"
  end
  if api.nvim_ui_send then
    pcall(api.nvim_ui_send, data)
  else
    io.stdout:write(data)
  end
end

return M
