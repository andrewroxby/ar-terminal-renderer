-- ar_term_render.server: one long-lived `ar-term-render serve` process that
-- turns formulas into PNGs, so each formula costs a request line instead of a
-- fresh node start, MathJax load and rsvg spawn (~120 ms).
--
-- The process starts on the first request, restarts when it dies with work
-- in flight, and exits on its own after ten idle minutes (the next request
-- starts it again). The protocol is newline-delimited JSON; see core/serve.ts.
--
-- Callers hear back through cb(res), where res is { path = "..." }, or
-- { error = "...", rejected = bool } for a formula the renderer answered
-- about, or { unavailable = true, error = "..." } when the server cannot be
-- used at all (an old renderer without `serve`, a binary that is not one) or
-- was stopped with the request in flight.
-- The caller then runs the renderer one formula at a time instead.

local uv = vim.uv

local M = {}

-- A request that finds the server dead is sent again this many times.
local ATTEMPTS = 2
-- No answer for this long means the server is stuck; it is killed.
local WATCHDOG_MS = 20000

-- The running process's handle, and its instance: the output buffers and
-- identity that callbacks check, so a killed process's late output is ignored.
local proc = nil
local cur = nil
local started_with = nil
-- True once this process has answered anything.
local proven = false
local broken = nil
local inflight = {}
local next_id = 0
local watchdog = nil

local function stop_watchdog()
  if watchdog then
    watchdog:stop()
    if not watchdog:is_closing() then
      watchdog:close()
    end
    watchdog = nil
  end
end

local start

local function arm_watchdog()
  stop_watchdog()
  if next(inflight) == nil then
    return
  end
  watchdog = uv.new_timer()
  watchdog:start(
    WATCHDOG_MS,
    0,
    vim.schedule_wrap(function()
      if proc then
        proc:kill(15)
      end
    end)
  )
end

local function send(req)
  local line = vim.json.encode(vim.tbl_extend("force", req.params, { id = req.id })) .. "\n"
  local ok = pcall(function()
    proc:write(line)
  end)
  return ok
end

local function answer(line)
  local ok, msg = pcall(vim.json.decode, line, { luanil = { object = true, array = true } })
  if not ok or type(msg) ~= "table" or msg.id == nil then
    return
  end
  local req = inflight[msg.id]
  if not req then
    return
  end
  inflight[msg.id] = nil
  proven = true
  arm_watchdog()
  if msg.path then
    req.cb({ path = msg.path })
  else
    req.cb({ error = msg.error or "no answer", rejected = msg.rejected == true })
  end
end

-- The server ended. Requests it had not answered go to a new one, or to the
-- caller's fallback when this one never worked or they have used their tries.
local function ended(code, signal, inst)
  if cur ~= inst then
    return
  end
  proc = nil
  cur = nil
  stop_watchdog()
  local lost = inflight
  inflight = {}
  if not proven then
    local err = vim.trim(inst.err)
    broken = err ~= "" and err or ("exit " .. tostring(code or signal))
  end
  local retry = {}
  for _, req in pairs(lost) do
    req.attempts = req.attempts + 1
    if broken or req.attempts > ATTEMPTS then
      req.cb({ unavailable = true, error = broken or "the renderer server kept dying" })
    else
      retry[#retry + 1] = req
    end
  end
  table.sort(retry, function(a, b)
    return a.id < b.id
  end)
  for _, req in ipairs(retry) do
    inflight[req.id] = req
  end
  if #retry > 0 then
    if start(started_with) then
      for _, req in ipairs(retry) do
        send(req)
      end
      arm_watchdog()
    else
      for _, req in ipairs(retry) do
        inflight[req.id] = nil
        req.cb({ unavailable = true, error = broken })
      end
    end
  end
end

start = function(argv)
  proven = false
  local cmd = vim.list_extend(vim.deepcopy(argv), { "serve" })
  local inst = { out = "", err = "" }
  local ok, handle = pcall(vim.system, cmd, {
    stdin = true,
    stdout = function(_, data)
      if not data then
        return
      end
      inst.out = inst.out .. data
      local lines = {}
      while true do
        local nl = inst.out:find("\n", 1, true)
        if not nl then
          break
        end
        lines[#lines + 1] = inst.out:sub(1, nl - 1)
        inst.out = inst.out:sub(nl + 1)
      end
      if #lines > 0 then
        vim.schedule(function()
          if cur ~= inst then
            return
          end
          for _, line in ipairs(lines) do
            answer(line)
          end
        end)
      end
    end,
    stderr = function(_, data)
      if data and #inst.err < 4000 then
        inst.err = inst.err .. data
      end
    end,
  }, function(res)
    vim.schedule(function()
      ended(res.code, res.signal, inst)
    end)
  end)
  if not ok then
    broken = tostring(handle)
    return false
  end
  proc = handle
  cur = inst
  started_with = argv
  return true
end

--- Asks the server for a PNG, starting it if needed.
--- @param argv string[] the renderer command, without `serve`
--- @param params table the `tex` request fields (see core/serve.ts)
--- @param cb fun(res: table)
function M.request(argv, params, cb)
  if broken then
    cb({ unavailable = true, error = broken })
    return
  end
  if proc and table.concat(started_with, "\0") ~= table.concat(argv, "\0") then
    -- A different renderer was configured; what the old one holds goes to the
    -- caller's fallback.
    M.stop()
  end
  if not proc and not start(argv) then
    cb({ unavailable = true, error = broken })
    return
  end
  next_id = next_id + 1
  local req = { id = next_id, params = params, cb = cb, attempts = 0 }
  inflight[req.id] = req
  if not send(req) then
    -- The process is already gone; its exit is on its way and will resend.
    return
  end
  if not watchdog then
    arm_watchdog()
  end
end

-- Kills the process and takes its work in flight, oldest first. The state is
-- consistent before any callback runs, so a callback may ask again.
local function drop()
  stop_watchdog()
  local p = proc
  proc = nil
  cur = nil
  local lost = inflight
  inflight = {}
  if p then
    pcall(function()
      p:kill(15)
    end)
  end
  local ordered = {}
  for _, req in pairs(lost) do
    ordered[#ordered + 1] = req
  end
  table.sort(ordered, function(a, b)
    return a.id < b.id
  end)
  return ordered
end

-- Tells each request that the server cannot answer it, which sends its
-- caller to the one-run-per-formula fallback.
local function give_back(lost)
  for _, req in ipairs(lost) do
    req.cb({ unavailable = true, error = "the renderer server was stopped" })
  end
end

--- Stops the server. Work in flight is answered as unavailable, so callers
--- finish it another way.
function M.stop()
  give_back(drop())
end

--- Stops the server and drops its work in flight without an answer, for
--- when the editor is exiting and nothing should start again.
function M.shutdown()
  drop()
end

--- Forgets that the server failed, so the next request tries it again. Work
--- in flight is answered as in stop().
function M.reset()
  local lost = drop()
  broken = nil
  proven = false
  give_back(lost)
end

--- Whether a server process is running, for tests and diagnostics.
function M.running()
  return proc ~= nil
end

--- The running server's process id, or nil.
function M.pid()
  return proc and proc.pid or nil
end

return M
