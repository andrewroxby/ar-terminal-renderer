-- ar_term_render.art: LaTeX as Unicode art through the cellmath CLI, the same
-- converter Pi and Claude Code draw with. It serves terminals without kitty
-- graphics and every formula an image cannot carry.
--
-- cellmath does not wrap, so a formula wider than its box is the caller's to
-- refuse; this module only reports what cellmath drew.

local queue = require("ar_term_render.queue")

local M = {}

M.config = {
  bin = "cellmath",
}

local warned_missing = false
-- Raw rows by mode and expression. Successes only: a spawn failure is
-- transient and must not stick for the session.
local memo = {}

local function command()
  local path = vim.fn.exepath(M.config.bin)
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

--- Draws one expression, answering through cb(rows|nil) with a list of
--- strings. Inline math must come back as one row, so nil covers anything
--- cellmath cannot draw flat, such as a matrix.
--- @param expr string LaTeX source, without delimiters
--- @param inline boolean text style in one row when true, display style otherwise
--- @param cb fun(rows: string[]|nil)
function M.render(expr, inline, cb)
  local key = (inline and "i:" or "d:") .. expr
  if memo[key] then
    cb(memo[key])
    return
  end
  local bin = command()
  if not bin then
    cb(nil)
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
    vim.system(cmd, { text = true, stdin = expr }, function(res)
      vim.schedule(function()
        local rows = nil
        if res.code == 0 and res.stdout and res.stdout:find("%S") then
          rows = vim.split(res.stdout:gsub("\n+$", ""), "\n", { plain = true })
          if inline and #rows ~= 1 then
            rows = nil
          end
        end
        if rows then
          memo[key] = rows
        end
        done(rows)
      end)
    end)
  end, cb)
end

return M
