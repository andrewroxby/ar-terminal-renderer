-- Lock spec: the Lua side of the transmit lock, and its agreement with
-- core/lock.ts.

local helpers = dofile(vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":h") .. "/helpers.lua")
local lock = require("ar_term_render.lock")

local saved_tmpdir = vim.env.TMPDIR

describe("lock", function()
  local dir

  before_each(function()
    dir = helpers.tmpdir()
  end)

  after_each(function()
    vim.env.TMPDIR = saved_tmpdir
    helpers.cleanup()
  end)

  it("names ar-term-render under $TMPDIR, without a doubled slash", function()
    vim.env.TMPDIR = dir .. "/"
    assert.are.equal(dir .. "/ar-term-render", lock.dir())
    vim.env.TMPDIR = dir
    assert.are.equal(dir .. "/ar-term-render", lock.dir())
  end)

  it("lets one taker in, and the next once it releases", function()
    local release = lock.try(dir)
    assert(release)
    assert.is_nil(lock.try(dir))
    release()
    assert.is_nil(vim.uv.fs_stat(dir .. "/transmit.lock"))
    local again = lock.try(dir)
    assert(again)
    again()
  end)

  it("creates the directory, and steals a lock older than three seconds", function()
    local nested = dir .. "/a/b"
    vim.fn.mkdir(nested .. "/transmit.lock", "p")
    local fresh = os.time()
    vim.uv.fs_utime(nested .. "/transmit.lock", fresh, fresh)
    assert.is_nil(lock.try(nested), "a fresh lock is respected")
    vim.uv.fs_utime(nested .. "/transmit.lock", fresh - 10, fresh - 10)
    local release = lock.try(nested)
    assert(release, "a stale lock is stolen")
    release()
  end)

  if vim.fn.exepath("node") ~= "" then
    -- Both sides must take the same directory by the same rule.
    local function core_takes(cache)
      local js = string.format(
        "import(%q).then(m => { const r = m.tryLock(%q, 0); process.stdout.write(r ? 'took' : 'busy'); r && r() })",
        helpers.root .. "/core/lock.ts",
        cache
      )
      return vim.system({ "node", "-e", js }, { text = true }):wait().stdout
    end

    it("excludes core/lock.ts, and is excluded by it", function()
      local cache = dir .. "/ar-term-render"
      local release = lock.try(cache)
      assert(release)
      assert.are.equal("busy", core_takes(cache))
      release()
      assert.are.equal("took", core_takes(cache))
      assert(lock.try(cache), "core released it")
    end)
  end
end)
