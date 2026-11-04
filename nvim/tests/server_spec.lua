-- Server spec: the persistent renderer process. Protocol behaviour runs
-- against a small fake that speaks it; the last group runs the real CLI.

local helpers = dofile(vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":h") .. "/helpers.lua")
local image = require("ar_term_render.image")
local queue = require("ar_term_render.queue")
local server = require("ar_term_render.server")
local terminal = require("ar_term_render.terminal")

local saved_tmpdir = vim.env.TMPDIR
local script = helpers.root .. "/core/cli.ts"

local FAKE = [[
import { appendFileSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const log = process.env.FAKE_LOG
appendFileSync(log, 'start\n')
const starts = readFileSync(log, 'utf8').split('\n').filter((l) => l === 'start').length
const crashAt = Number(process.env.FAKE_CRASH_AT || 0)
let n = 0
createInterface({ input: process.stdin }).on('line', (line) => {
  const q = JSON.parse(line)
  n++
  if (starts === 1 && crashAt > 0 && n >= crashAt) process.exit(1)
  process.stdout.write(JSON.stringify({ id: q.id, path: process.env.FAKE_PNG }) + '\n')
})
]]

-- A renderer command that runs the fake, and the log it writes.
local function fake(dir)
  local js = dir .. "/fake.mjs"
  local f = assert(io.open(js, "w"))
  f:write(FAKE)
  f:close()
  vim.env.FAKE_LOG = dir .. "/log"
  vim.env.FAKE_PNG = js
  return { helpers.script(dir, "ar", 'exec node ' .. js .. ' "$@"') }
end

local function starts(dir)
  local n = 0
  for _, l in ipairs(helpers.lines(dir .. "/log")) do
    if l == "start" then
      n = n + 1
    end
  end
  return n
end

-- Sends n requests at once and answers their results in order.
local function ask(argv, n)
  local results, got = {}, 0
  for i = 1, n do
    server.request(argv, { tex = "x" .. i }, function(res)
      results[i] = res
      got = got + 1
    end)
  end
  assert(vim.wait(10000, function()
    return got == n
  end, 20), "the server did not answer")
  return results
end

local function restore()
  server.reset()
  image.setup()
  terminal.setup()
  vim.env.TMPDIR = saved_tmpdir
  vim.env.FAKE_CRASH_AT = nil
  vim.env.AR_TERM_RENDER_IDLE_MS = nil
  helpers.cleanup()
end

describe("the renderer server", function()
  local dir

  before_each(function()
    dir = helpers.tmpdir()
    server.reset()
  end)

  after_each(restore)

  it("answers many requests from one process", function()
    local argv = fake(dir)
    for _, res in ipairs(ask(argv, 6)) do
      assert.are.equal(vim.env.FAKE_PNG, res.path)
    end
    assert.are.equal(1, starts(dir))
    assert.is_true(server.running())
  end)

  it("starts lazily and stops on request, taking the process with it", function()
    assert.is_false(server.running())
    ask(fake(dir), 1)
    local pid = server.pid()
    assert(pid and vim.uv.kill(pid, 0) == 0, "expected a live process")
    server.stop()
    assert.is_false(server.running())
    assert(vim.wait(5000, function()
      return vim.uv.kill(pid, 0) ~= 0
    end, 20), "the process should be gone")
  end)

  it("restarts after a crash and sends the lost requests again", function()
    vim.env.FAKE_CRASH_AT = "2"
    local results = ask(fake(dir), 3)
    for i, res in ipairs(results) do
      assert.are.equal(vim.env.FAKE_PNG, res.path, "request " .. i)
    end
    assert.are.equal(2, starts(dir))
  end)

  it("reports a binary that is not a server as unavailable, once, and stops trying", function()
    local ran = dir .. "/ran"
    local bin = { helpers.script(dir, "ar", "echo x >> " .. ran .. '\necho "ar-term-render: unknown command serve" >&2\nexit 2') }
    local first = ask(bin, 1)[1]
    assert.is_true(first.unavailable)
    assert(first.error:find("unknown command serve", 1, true), first.error)
    local second = ask(bin, 1)[1]
    assert.is_true(second.unavailable)
    assert.are.equal(1, #helpers.lines(ran), "the server was not started again")
    server.reset()
    ask(bin, 1)
    assert.are.equal(2, #helpers.lines(ran), "reset lets it try again")
  end)

  it("ignores what a stopped server writes late", function()
    -- A server that never answers and, when killed, answers every id with a stale path.
    local stale = {
      helpers.script(
        dir,
        "stale",
        [[trap 'i=1; while [ $i -le 500 ]; do printf "{\"id\":%d,\"path\":\"/stale\"}\n" $i; i=$((i+1)); done; exit 0' TERM
while :; do sleep 0.05; done]]
      ),
    }
    server.request(stale, { tex = "a" }, function() end)
    vim.wait(200)
    local other = helpers.tmpdir()
    local results = ask(fake(other), 3)
    for i, res in ipairs(results) do
      assert.are.equal(vim.env.FAKE_PNG, res.path, "request " .. i)
    end
  end)

  it("sends requests to a new process when the renderer command changes", function()
    local a = fake(dir)
    ask(a, 1)
    local other = helpers.tmpdir()
    local b = fake(other)
    ask(b, 1)
    assert.are.equal(1, starts(other))
  end)
end)

local have_cli = vim.fn.exepath("ar-term-render") ~= "" or (vim.fn.exepath("node") ~= "" and vim.uv.fs_stat(script) ~= nil)
local have_rsvg = vim.fn.exepath("rsvg-convert") ~= ""

if have_cli and have_rsvg then
  describe("the real renderer server", function()
    local dir, log, bin

    local function render(expr, display)
      local done, result = false, nil
      image.render(expr, display, 40, function(img)
        result = img
        done = true
      end)
      assert(vim.wait(20000, function()
        return done
      end, 20), "render did not finish")
      return result
    end

    before_each(function()
      dir = helpers.tmpdir()
      log = dir .. "/args"
      vim.env.TMPDIR = helpers.tmpdir()
      terminal.setup({ cell = { w = 16, h = 32 } })
      bin = helpers.script(dir, "ar", 'echo "$1" >> ' .. log .. '\nexec node ' .. script .. ' "$@"')
      image.setup({ ar_bin = bin })
    end)

    after_each(restore)

    it("draws every formula through one `serve` process", function()
      for _, expr in ipairs({ "a^2", "b^2", "c^2", [[\frac{a}{b}]] }) do
        assert(render(expr, true), expr)
      end
      assert(render("x_1", false))
      assert.are.same({ "serve" }, helpers.lines(log))
    end)

    it("still reports a formula the renderer refuses", function()
      assert.is_nil(render([[\frac{1}{]], true))
      assert.are.same({ "serve" }, helpers.lines(log))
    end)

    it("exits when idle and starts again on the next formula", function()
      vim.env.AR_TERM_RENDER_IDLE_MS = "300"
      image.setup({ ar_bin = bin })
      assert(render("a^2", true))
      assert.is_true(server.running())
      assert(vim.wait(10000, function()
        return not server.running()
      end, 20), "the idle server should exit")
      assert(render("b^2", true))
      assert.are.same({ "serve", "serve" }, helpers.lines(log))
    end)

    it("draws every formula when setup() runs again mid-render", function()
      local drawn, total = 0, 10
      for i = 1, total do
        image.render("x_{" .. i .. "}^2", true, 40, function(img)
          if img then
            drawn = drawn + 1
          end
        end)
      end
      image.setup({ ar_bin = bin })
      assert(vim.wait(30000, function()
        return queue.stats().keys == 0
      end, 20), "the queue never drained")
      assert.are.equal(total, drawn)
      assert.are.same({ running = 0, pending = 0, keys = 0 }, queue.stats())
    end)

    it("falls back to one run per formula when persistent is off", function()
      image.setup({ ar_bin = bin, persistent = false })
      assert(render("a^2", true))
      assert.are.same({ "tex" }, helpers.lines(log))
      assert.is_false(server.running())
    end)
  end)
end
