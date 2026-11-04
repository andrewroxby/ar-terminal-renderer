-- Queue spec: the fan-out bound and the shared-run behaviour that keep a
-- math-heavy buffer from exhausting file descriptors or racing on a cache
-- file. Pure scheduling, no subprocesses.

local queue = require("ar_term_render.queue")

describe("queue", function()
  local finishers

  before_each(function()
    queue.reset()
    queue.limit = 3
    finishers = {}
  end)

  -- A job that parks until the test releases it, so concurrency is
  -- observable rather than a matter of timing.
  local function parked(key, results)
    queue.submit(key, function(done)
      table.insert(finishers, done)
    end, function(value)
      table.insert(results, value)
    end)
  end

  it("runs no more than the limit at once", function()
    local results = {}
    for i = 1, 10 do
      parked("job" .. i, results)
    end
    assert.are.same(3, queue.stats().running)
    assert.are.same(7, queue.stats().pending)

    finishers[1]("a")
    assert.are.same(3, queue.stats().running)
    assert.are.same(6, queue.stats().pending)

    -- Draining has to follow the list as it grows: finishing one job starts
    -- the next, which appends its own finisher.
    local i = 2
    while i <= #finishers do
      finishers[i]("done")
      i = i + 1
    end
    assert.are.same(0, queue.stats().pending)
    assert.are.same(0, queue.stats().running)
    assert.are.same(10, #results)
  end)

  it("shares one run between callers asking for the same key", function()
    local results = {}
    parked("same", results)
    parked("same", results)
    parked("same", results)
    assert.are.same(1, queue.stats().running)

    finishers[1]("shared")
    assert.are.same({ "shared", "shared", "shared" }, results)
    assert.are.same(1, #finishers)
  end)

  it("keeps distinct keys distinct", function()
    local results = {}
    parked("a", results)
    parked("b", results)
    assert.are.same(2, queue.stats().running)
    finishers[1](1)
    finishers[2](2)
    assert.are.same({ 1, 2 }, results)
  end)
end)
