-- termtex.queue: bounded fan-out for renderer subprocesses.
--
-- A buffer full of math asks for every formula at once. One process per
-- formula exhausts the file-descriptor table ("too many open files") long
-- before it exhausts patience, so jobs run a few at a time.
--
-- Jobs also carry a key. Two spans holding the same formula share one run
-- instead of racing each other, which matters beyond efficiency: both would
-- otherwise write the same cache file while the other read it.

local M = {}

M.limit = 3

local running = 0
local pending = {}
local waiters = {}

local function step()
  while running < M.limit do
    local job = table.remove(pending, 1)
    if not job then
      return
    end
    running = running + 1
    job.run(function(...)
      running = running - 1
      local followers = waiters[job.key] or {}
      waiters[job.key] = nil
      for _, cb in ipairs(followers) do
        cb(...)
      end
      step()
    end)
  end
end

--- Queue one job. `run` receives a done callback and must call it exactly
--- once, with whatever results the callers expect.
--- @param key string identity of the work; equal keys share one run
--- @param run fun(done: fun(...))
--- @param cb fun(...)
function M.submit(key, run, cb)
  if waiters[key] then
    table.insert(waiters[key], cb)
    return
  end
  waiters[key] = { cb }
  table.insert(pending, { key = key, run = run })
  step()
end

--- Forget all queued work. Running jobs still finish, but nothing waiting
--- is started and their callers never hear back.
function M.reset()
  running = 0
  pending = {}
  waiters = {}
end

--- Jobs running and waiting, for tests and diagnostics.
function M.stats()
  local queued = 0
  for _ in pairs(waiters) do
    queued = queued + 1
  end
  return { running = running, pending = #pending, keys = queued }
end

return M
