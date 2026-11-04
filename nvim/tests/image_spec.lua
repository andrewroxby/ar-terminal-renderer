-- Image spec: ar_term_render.image against the real ar-term-render CLI. The
-- drawing specs skip themselves when ar-term-render (node, rsvg-convert) is
-- missing.

local helpers = dofile(vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":h") .. "/helpers.lua")
local image = require("ar_term_render.image")
local lock = require("ar_term_render.lock")
local terminal = require("ar_term_render.terminal")

local script = helpers.root .. "/core/cli.ts"
local saved_tmpdir = vim.env.TMPDIR

local function restore()
  image.setup()
  terminal.setup()
  vim.env.TMPDIR = saved_tmpdir
  helpers.cleanup()
end

local have_cli = vim.fn.exepath("ar-term-render") ~= ""
  or (vim.fn.exepath("node") ~= "" and vim.uv.fs_stat(script) ~= nil)
local have_rsvg = vim.fn.exepath("rsvg-convert") ~= ""

-- Answers the image and the transient flag.
local function render(expr, display, cols, indent)
  local done, result, transient = false, nil, nil
  image.render(expr, display, cols, function(img, t)
    result, transient = img, t
    done = true
  end, indent)
  assert(vim.wait(20000, function()
    return done
  end, 50), "render did not finish")
  return result, transient
end

-- A sum of n subscripted letters, about 1.8 em wide per term.
local function terms(n)
  local parts = {}
  for i = 1, n do
    parts[i] = "a_{" .. i .. "}"
  end
  return table.concat(parts, " + ")
end

local function is_png(path)
  local f = io.open(path, "rb")
  if not f then
    return false
  end
  local head = f:read(8)
  f:close()
  return head == "\137PNG\r\n\26\n"
end

describe("renderer lookup", function()
  after_each(restore)

  if have_cli then
    it("finds the CLI, from this checkout when it is not on PATH", function()
      image.setup({ ar_bin = "no-such-ar-term-render" })
      local cmd = image.command()
      assert(cmd and cmd[#cmd]:match("core/cli%.ts$"), "expected the checkout's core/cli.ts")
    end)
  end

  it("warns once, and answers nil, when the CLI cannot be found", function()
    local warnings = {}
    local notify = vim.notify
    vim.notify = function(msg, level)
      warnings[#warnings + 1] = { msg, level }
    end
    image.setup({ ar_bin = "no-such-ar-term-render", ar_fallback_script = "/nonexistent/cli.ts" })
    local first = image.command()
    local second = image.command()
    vim.notify = notify
    assert.is_nil(first)
    assert.is_nil(second)
    assert.are.equal(1, #warnings)
    assert(warnings[1][1]:find("renderer not found", 1, true))
    assert.is_nil(render([[x^2]], true, 40))
  end)

  it("warns once, naming the Node requirement, when node is too old, and does not run the renderer", function()
    local dir = helpers.tmpdir()
    local node = helpers.script(dir, "node", "echo v20.11.0")
    local ran = dir .. "/ran"
    local bin = helpers.script(dir, "ar", "echo x >> " .. ran)
    local warnings = {}
    local notify = vim.notify
    vim.notify = function(msg)
      warnings[#warnings + 1] = msg
    end
    image.setup({ ar_bin = bin, node = node })
    local img, transient = render([[x^2]], true, 40)
    render([[y^2]], true, 40)
    vim.notify = notify
    assert.is_nil(img)
    assert.is_true(transient)
    assert.are.equal(1, #warnings)
    assert(warnings[1]:find("Node 22.18+ or 24.2+", 1, true), warnings[1])
    assert(warnings[1]:find("v20.11.0", 1, true), warnings[1])
    assert.are.same({}, helpers.lines(ran))
  end)

  it("accepts the Node releases that run the CLI", function()
    local dir = helpers.tmpdir()
    local bin = helpers.script(dir, "ar", "true")
    for version, ok in pairs({ ["v22.18.0"] = true, ["v22.17.9"] = false, ["v23.9.0"] = false, ["v24.1.0"] = false, ["v24.2.0"] = true, ["v26.1.0"] = true }) do
      local node = helpers.script(dir, "node", "echo " .. version)
      local notify = vim.notify
      vim.notify = function() end
      image.setup({ ar_bin = bin, node = node })
      local cmd = image.command()
      vim.notify = notify
      assert.are.equal(ok, cmd ~= nil, version)
    end
  end)
end)

describe("the PNG frames", function()
  local saved_tmux

  before_each(function()
    saved_tmux = vim.env.TMUX
    vim.env.TMUX = nil
  end)

  after_each(function()
    vim.env.TMUX = saved_tmux
  end)

  it("carry q=2 on every frame, so the terminal never answers into the editor", function()
    local data = string.rep("\1\2\3\4\5\6\7\8", 2000)
    local frames = image.frames(7, data, 4, 2)
    assert(#frames >= 4, "expected several frames")
    assert(frames[1]:find("a=T,U=1,i=7,p=7,f=100,c=4,r=2,q=2,m=1;", 1, true), frames[1]:sub(1, 80))
    for k = 2, #frames - 1 do
      assert(frames[k]:find("\027_Gq=2,m=1;", 1, true), "frame " .. k)
    end
    assert(frames[#frames]:find("\027_Gq=2,m=0;", 1, true), "last frame")
    local payload = {}
    for _, frame in ipairs(frames) do
      payload[#payload + 1] = frame:match(";(.*)\027\\")
    end
    assert.are.equal(data, vim.base64.decode(table.concat(payload)))
  end)

  it("go through the tmux wrapper, one frame at a time", function()
    vim.env.TMUX = "/tmp/x,1,0"
    local frames = image.frames(7, string.rep("x", 6000), 1, 1)
    assert.are.equal(2, #frames)
    for _, frame in ipairs(frames) do
      assert.are.equal("\027Ptmux;\027\027_G", frame:sub(1, 11))
    end
  end)

  it("fit one frame when the image is small", function()
    local frames = image.frames(7, "tiny", 1, 1)
    assert.are.equal(1, #frames)
    assert(frames[1]:find(",m=0;", 1, true))
  end)
end)

describe("failed renderer runs", function()
  local dir, ran

  before_each(function()
    dir = helpers.tmpdir()
    ran = dir .. "/ran"
    vim.env.TMPDIR = dir
    local node = helpers.script(dir, "node", "echo v26.0.0")
    image.setup({ node = node })
  end)

  after_each(restore)

  it("remembers a formula the renderer rejects, and does not run it again", function()
    local bin = helpers.script(dir, "ar", "echo x >> " .. ran .. '\necho "ar-term-render: could not typeset that LaTeX" >&2\nexit 1')
    image.setup({ ar_bin = bin, node = dir .. "/node", persistent = false })
    local img, transient = render([[\frac{1}{]], true, 40)
    assert.is_nil(img)
    assert.is_nil(transient)
    render([[\frac{1}{]], true, 40)
    assert.are.equal(1, #helpers.lines(ran))
    render([[\frac{2}{]], true, 40)
    assert.are.equal(2, #helpers.lines(ran), "another formula is its own question")
  end)

  it("does not remember a run that failed outright, and warns once about it", function()
    local bin = helpers.script(dir, "ar", "echo x >> " .. ran .. '\necho "SyntaxError: nope" >&2\nexit 1')
    image.setup({ ar_bin = bin, node = dir .. "/node", persistent = false })
    local warnings = {}
    local notify = vim.notify
    vim.notify = function(msg)
      warnings[#warnings + 1] = msg
    end
    local img, transient = render([[x^2]], true, 40)
    render([[x^2]], true, 40)
    vim.notify = notify
    assert.is_nil(img)
    assert.is_true(transient)
    assert.are.equal(2, #helpers.lines(ran), "the formula was asked for again")
    assert.are.equal(1, #warnings)
    assert(warnings[1]:find("SyntaxError", 1, true))
    assert(warnings[1]:find("Node 22.18+ or 24.2+", 1, true))
  end)

  it("treats a signal or an odd exit code as a failed run too", function()
    local bin = helpers.script(dir, "ar", "echo x >> " .. ran .. "\nexit 3")
    image.setup({ ar_bin = bin, node = dir .. "/node", persistent = false })
    local notify = vim.notify
    vim.notify = function() end
    local _, transient = render([[x^2]], true, 40)
    vim.notify = notify
    assert.is_true(transient)
  end)
end)

if have_cli and have_rsvg then
  describe("drawing", function()
    local cache

    before_each(function()
      vim.env.TMPDIR = helpers.tmpdir()
      cache = lock.dir()
      terminal.setup({ cell = { w = 16, h = 32 } })
    end)

    after_each(restore)

    local function pngs()
      return vim.fn.glob(cache .. "/*.png", false, true)
    end

    it("draws display math as placeholder rows inside the column budget", function()
      local img = render([[\frac{a+b}{2} + x^2]], true, 40)
      assert(img, "expected an image")
      assert(img.cols >= 1 and img.cols <= 40)
      assert(img.rows >= 1)
      assert.are.equal(img.rows, #img.lines)
      assert(img.hl:match("^ArRenderImage%d+$"))
      assert(#pngs() >= 1, "expected a cached PNG")
      assert(is_png(pngs()[1]), "cache entry should be a PNG")
    end)

    it("keeps the PNGs in the renderer's own cache, the one the lock guards", function()
      render([[\alpha]], true, 40)
      assert.are.equal(1, #pngs())
      local node = vim.fn.exepath("node")
      local out = vim.system({ node, "-p", "require('path').join(process.env.TMPDIR || require('os').tmpdir(), 'ar-term-render')" }, { text = true }):wait()
      assert.are.equal(vim.trim(out.stdout), cache)
    end)

    it("keeps the image id inside a 24-bit highlight foreground", function()
      local img = render([[\alpha]], true, 40)
      local group = vim.api.nvim_get_hl(0, { name = img.hl, link = false })
      assert(group.fg and group.fg > 0 and group.fg <= 0xFFFFFF, "image id must fit a 24-bit colour")
      assert.are.equal(img.id, group.fg)
      assert.are.equal(group.fg, group.sp, "underline colour must carry the matching placement id")
    end)

    it("sets the highlight groups again after :colorscheme clears them", function()
      local img = render([[\alpha]], true, 40)
      vim.cmd("highlight clear")
      assert.is_nil(vim.api.nvim_get_hl(0, { name = img.hl, link = false }).fg)
      image.rehighlight()
      local group = vim.api.nvim_get_hl(0, { name = img.hl, link = false })
      assert.are.equal(img.id, group.fg)
      assert.are.equal(img.id, group.sp)
    end)

    it("keeps inline math to one row", function()
      local img = render("x^2", false, 40)
      assert(img, "expected an image")
      assert.are.equal(1, img.rows)
    end)

    it("reuses the cached PNG and terminal image for a repeated formula", function()
      local a = render([[\alpha + \beta]], true, 40)
      local before = #pngs()
      local b = render([[\alpha + \beta]], true, 40)
      assert.are.equal(a.id, b.id)
      assert.are.equal(before, #pngs())
    end)

    it("asks the renderer again when its PNG has gone from the cache", function()
      local a = render([[\alpha + \beta]], true, 40)
      vim.fn.delete(cache, "rf")
      local b = render([[\alpha + \beta]], true, 40)
      assert(b, "expected an image")
      assert.are.equal(1, #pngs())
      assert.are.equal(a.id, b.id, "the same picture keeps its terminal id")
    end)

    it("draws in the text colour, and a new colour is a new picture", function()
      vim.api.nvim_set_hl(0, "Normal", { fg = 0xaa0000 })
      local a = render([[\alpha]], true, 40)
      vim.api.nvim_set_hl(0, "Normal", { fg = 0x00aa00 })
      local b = render([[\alpha]], true, 40)
      vim.api.nvim_set_hl(0, "Normal", {})
      assert.are_not.equal(a.id, b.id)
      assert.are.equal(2, #pngs())
    end)

    it("measures the canvas against the cell the em was chosen for", function()
      local dir = helpers.tmpdir()
      local log = dir .. "/args"
      local bin = helpers.script(dir, "ar", "echo \"$@\" >> " .. log .. "\nexec node " .. script .. ' "$@"')
      image.setup({ ar_bin = bin, persistent = false })
      -- The cell changes under the renderer, as after a font change.
      local reads = 0
      local cell = terminal.cell
      terminal.cell = function()
        reads = reads + 1
        return reads == 1 and { w = 16, h = 32 } or { w = 8, h = 8 }
      end
      local img = render([[x^2]], true, 40)
      terminal.cell = cell
      assert(img)
      for _, line in ipairs(helpers.lines(log)) do
        assert(line:find("--cell 16x32", 1, true), line)
      end
    end)

    it("draws on a whole-cell canvas, so the terminal never stretches it", function()
      for _, display in ipairs({ true, false }) do
        vim.fn.delete(cache, "rf")
        local img = render([[x^2 + y^2]], display, 40)
        assert.are.equal(1, #pngs())
        local f = io.open(pngs()[1], "rb")
        local head = f:read(24)
        f:close()
        local function be32(at)
          local a, b, c, d = head:byte(at, at + 3)
          return ((a * 256 + b) * 256 + c) * 256 + d
        end
        assert.are.equal(img.cols * 16, be32(17))
        assert.are.equal(img.rows * 32, be32(21))
      end
    end)

    it("starts display math at display_em cell heights per em", function()
      local small = render([[\frac{a+b}{2} + x^2]], true, 100)
      image.setup({ display_em = 1.6 })
      local large = render([[\frac{a+b}{2} + x^2]], true, 100)
      -- Whole-cell padding blurs the ratio by up to a cell on each side.
      assert(large.cols >= 2 * small.cols - 2 and large.cols <= 2 * small.cols, "em should scale the width")
    end)

    it("keeps display math inside the column budget by shrinking it", function()
      local img = render([[P_{\text{upset}} = \frac{1}{1 + 10^{D\sqrt{N}/2000}}]], true, 20)
      assert(img, "a formula that can shrink to fit must still render")
      assert(img.cols <= 20, "expected at most 20 columns, got " .. img.cols)
    end)

    it("gives up, as Pi does, when math would have to shrink below half an em per cell height", function()
      local wide = terms(30)
      assert.is_nil(render(wide, true, 30))
      assert(render(wide, true, 100), "the same formula draws in a wide window")
    end)

    describe("display width", function()
      -- Pi's budget: the width less two and the indent, at most 100 columns.
      local expr = [[\frac{a+b}{2} + x^2 + y^2 + z^2]]

      it("leaves two columns free", function()
        local natural = render(expr, true, 100, 0).cols
        assert.are.equal(natural, render(expr, true, natural + 2, 0).cols)
        assert(render(expr, true, natural + 1, 0).cols < natural, "one column short of the budget shrinks it")
      end)

      it("never takes more than 100 columns", function()
        assert(render(terms(40), true, 300).cols <= 100)
      end)
    end)

    describe("display indent", function()
      local expr = [[\frac{a+b}{2} + x^2 + y^2 + z^2]]

      it("keeps the indent when the formula does not have to shrink", function()
        local natural = render(expr, true, 100, 0).cols
        local img = render(expr, true, natural + 5, 3)
        assert.are.equal(3, img.indent)
        assert.are.equal(natural, img.cols)
      end)

      it("drops the indent when keeping it would shrink the formula", function()
        local natural = render(expr, true, 100, 0).cols
        local img = render(expr, true, natural + 3, 3)
        assert.are.equal(0, img.indent)
        assert.are.equal(natural, img.cols)
      end)

      it("drops the indent when the formula shrinks either way, since flush shrinks less", function()
        local natural = render(expr, true, 100, 0).cols
        local img = render(expr, true, natural - 2, 3)
        assert.are.equal(0, img.indent)
        assert(img.cols <= natural - 4)
      end)

      it("never indents inline math", function()
        assert.are.equal(0, render("x^2", false, 40, 3).indent)
      end)
    end)

    describe("inline fit", function()
      it("never returns an image taller than one row", function()
        for _, f in ipairs({ "x^2", [[e^{i\pi}+1=0]], [[P_{\text{upset}}]], [[\sum_{i=1}^{n} i]], [[\alpha_1 + \beta^2]] }) do
          local img = render(f, false, 80)
          if img then
            assert(img.rows == 1, f .. " returned " .. img.rows .. " rows")
          end
        end
      end)

      it("keeps scripted math as images", function()
        for _, expr in ipairs({
          [[P_{\text{upset}}]],
          [[\sum_{i=1}^{n} i]],
          "[d_{model}, \\text{vocab}]",
          [[\alpha_1 + \beta^2]],
        }) do
          local img = render(expr, false, 80)
          assert(img, expr .. " should render as an image, not fall back to art")
          assert(img.rows == 1, expr .. " must occupy one row")
        end
      end)

      it("refuses stacked constructs without rasterizing them", function()
        for _, expr in ipairs({
          [[\frac{1}{2}]],
          [[\frac{\sqrt{\pi}}{2}]],
          [[\begin{pmatrix} a \\ b \end{pmatrix}]],
          [[\begin{cases} 1 & x \\ 0 & y \end{cases}]],
        }) do
          assert.is_nil(render(expr, false, 80), expr .. " should go straight to art")
        end
        assert.are.equal(0, #pngs(), "no PNG should have been written")
      end)
    end)

    it("gives up cleanly (nil, so art takes over) on TeX it cannot typeset", function()
      local img, transient = render([[\frac{1}{]], true, 40)
      assert.is_nil(img)
      assert.is_nil(transient, "a rejection is the formula's, not a failed run")
    end)

    describe("transmission", function()
      local original_send, original_write, sent_to_terminal

      before_each(function()
        original_send, original_write = terminal.send, terminal.write
        sent_to_terminal = {}
        terminal.send = function(data)
          sent_to_terminal[#sent_to_terminal + 1] = data
        end
        terminal.write = terminal.send
      end)

      after_each(function()
        terminal.send, terminal.write = original_send, original_write
        image.delete_all()
      end)

      it("sends the image once, and again only on resend", function()
        local img = render([[\alpha]], true, 40)
        assert.are.equal(1, #sent_to_terminal)
        render([[\alpha]], true, 40)
        assert.are.equal(1, #sent_to_terminal)
        image.resend({ [img.id] = true })
        assert.are.equal(2, #sent_to_terminal)
        image.resend({ [img.id + 1000000] = true })
        assert.are.equal(2, #sent_to_terminal, "an id this module does not own is left alone")
      end)

      it("waits while another process holds the transmit lock, then sends", function()
        local release = assert(lock.try())
        local img = render([[\alpha]], true, 40)
        assert(img, "the rows are drawn at once")
        assert.are.equal(0, #sent_to_terminal)
        release()
        assert(vim.wait(2000, function()
          return #sent_to_terminal == 1
        end, 20), "the image should go out once the lock frees")
      end)

      it("steals a stale lock instead of waiting on it", function()
        local dir = lock.dir()
        vim.fn.mkdir(dir .. "/transmit.lock", "p")
        vim.uv.fs_utime(dir .. "/transmit.lock", os.time() - 60, os.time() - 60)
        render([[\alpha]], true, 40)
        assert.are.equal(1, #sent_to_terminal)
      end)

      it("deletes with d=I, which frees the image data as well as its placements", function()
        local img = render([[\alpha]], true, 40)
        sent_to_terminal = {}
        image.delete(img.id)
        assert.are.equal(1, #sent_to_terminal)
        assert(sent_to_terminal[1]:find(string.format("a=d,d=I,i=%d,", img.id), 1, true), sent_to_terminal[1])
        image.delete(img.id)
        assert.are.equal(1, #sent_to_terminal, "a deleted image is not deleted twice")
      end)
    end)
  end)
end
