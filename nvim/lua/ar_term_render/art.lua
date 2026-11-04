-- ar_term_render.art: LaTeX as Unicode art through the cellmath CLI, the same
-- converter Pi and Claude Code draw with. It serves terminals without kitty
-- graphics and every formula an image cannot carry.
--
-- cellmath does not wrap, so a formula wider than its box is the caller's to
-- refuse; this module only reports what cellmath drew.

local queue = require("ar_term_render.queue")

local M = {}

local defaults = {
  bin = "cellmath",
}

local config = vim.deepcopy(defaults)

--- Replaces the options with the defaults plus `opts` ({ bin = "cellmath" }).
function M.setup(opts)
  config = vim.tbl_deep_extend("force", vim.deepcopy(defaults), opts or {})
end

local warned_missing = false
-- Raw rows by mode and expression, `false` for an expression cellmath
-- rejects. A failed run (no exit code, or a signal) is transient and is not
-- remembered.
local memo = {}

local function command()
  local path = vim.fn.exepath(config.bin)
  if path == "" then
    if not warned_missing then
      warned_missing = true
      vim.notify("ar-term-render: cellmath not found on PATH", vim.log.levels.WARN)
    end
    return nil
  end
  warned_missing = false
  return path
end

--- Draws one expression, answering through cb(rows|nil, transient) with a
--- list of strings. Inline math must come back as one row, so nil covers
--- anything cellmath cannot draw flat, such as a matrix. transient is true
--- when nil came from a failed run rather than from the expression, so the
--- caller should not remember it.
--- @param expr string LaTeX source, without delimiters
--- @param inline boolean text style in one row when true, display style otherwise
--- @param cb fun(rows: string[]|nil, transient: boolean|nil)
function M.render(expr, inline, cb)
  local key = (inline and "i:" or "d:") .. expr
  local known = memo[key]
  if known ~= nil then
    cb(known or nil)
    return
  end
  local bin = command()
  if not bin then
    cb(nil, true)
    return
  end
  local cmd = { bin, "--plain" }
  if inline then
    cmd[#cmd + 1] = "--inline"
  end
  -- The expression goes in on stdin, so its first character can never be
  -- read as a flag. The queue keeps a math-heavy buffer from starting one
  -- process per formula at once.
  queue.submit("art:" .. key, function(done)
    local ok = pcall(vim.system, cmd, { text = true, stdin = expr }, function(res)
      vim.schedule(function()
        -- Exit 0 or 1 is cellmath's own answer; anything else is the run failing.
        if (res.code ~= 0 and res.code ~= 1) or (res.signal or 0) ~= 0 then
          done(nil, true)
          return
        end
        local rows = nil
        if res.code == 0 and res.stdout and res.stdout:find("%S") then
          rows = vim.split(res.stdout:gsub("\n+$", ""), "\n", { plain = true })
          if inline and #rows ~= 1 then
            rows = nil
          end
        end
        memo[key] = rows or false
        done(rows)
      end)
    end)
    if not ok then
      done(nil, true)
    end
  end, cb)
end

return M
