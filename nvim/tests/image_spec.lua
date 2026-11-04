-- Image spec: ar_term_render.image against the real ar-term-render CLI. The
-- drawing specs skip themselves when ar-term-render (node, rsvg-convert) is
-- missing.

local image = require("ar_term_render.image")
local terminal = require("ar_term_render.terminal")

local saved = vim.deepcopy(image.config)
local saved_cell = vim.deepcopy(terminal.config.cell)

local function restore()
  image.config = vim.deepcopy(saved)
  terminal.config.cell = vim.deepcopy(saved_cell)
  terminal.invalidate_cell()
end

local have_cli = vim.fn.exepath("ar-term-render") ~= ""
  or (vim.fn.exepath("node") ~= "" and vim.uv.fs_stat(saved.ar_fallback_script) ~= nil)
local have_rsvg = vim.fn.exepath("rsvg-convert") ~= ""

local function render(expr, display, cols, indent)
  local done, result = false, nil
  image.render(expr, display, cols, function(img)
    result = img
    done = true
  end, indent)
  assert(vim.wait(20000, function()
    return done
  end, 50), "render did not finish")
  return result
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
      image.config.ar_bin = "no-such-ar-term-render"
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
    image.config.ar_bin = "no-such-ar-term-render"
    image.config.ar_fallback_script = "/nonexistent/cli.ts"
    local first = image.command()
    local second = image.command()
    vim.notify = notify
    assert.is_nil(first)
    assert.is_nil(second)
    assert.are.equal(1, #warnings)
    assert(warnings[1][1]:find("renderer not found", 1, true))
    assert.is_nil(render([[x^2]], true, 40))
  end)
end)

if have_cli and have_rsvg then
  describe("drawing", function()
    local cache

    before_each(function()
      cache = vim.fn.tempname()
      image.config.cache_dir = cache
      terminal.config.cell = { w = 16, h = 32 }
      terminal.invalidate_cell()
    end)

    after_each(function()
      vim.fn.delete(cache, "rf")
      restore()
    end)

    it("draws display math as placeholder rows inside the column budget", function()
      local img = render([[\frac{a+b}{2} + x^2]], true, 40)
      assert(img, "expected an image")
      assert(img.cols >= 1 and img.cols <= 40)
      assert(img.rows >= 1)
      assert.are.equal(img.rows, #img.lines)
      assert(img.hl:match("^ArRenderImage%d+$"))
      local pngs = vim.fn.glob(cache .. "/*.png", false, true)
      assert(#pngs >= 1, "expected a cached PNG")
      assert(is_png(pngs[1]), "cache entry should be a PNG")
    end)

    it("keeps the image id inside a 24-bit highlight foreground", function()
      local img = render([[\alpha]], true, 40)
      local group = vim.api.nvim_get_hl(0, { name = img.hl, link = false })
      assert(group.fg and group.fg > 0 and group.fg <= 0xFFFFFF, "image id must fit a 24-bit colour")
      assert.are.equal(img.id, group.fg)
      assert.are.equal(group.fg, group.sp, "underline colour must carry the matching placement id")
    end)

    it("keeps inline math to one row", function()
      local img = render("x^2", false, 40)
      assert(img, "expected an image")
      assert.are.equal(1, img.rows)
    end)

    it("reuses the cached PNG and terminal image for a repeated formula", function()
      local a = render([[\alpha + \beta]], true, 40)
      local before = #vim.fn.glob(cache .. "/*.png", false, true)
      local b = render([[\alpha + \beta]], true, 40)
      assert.are.equal(a.id, b.id)
      assert.are.equal(before, #vim.fn.glob(cache .. "/*.png", false, true))
    end)

    it("draws on a whole-cell canvas, so the terminal never stretches it", function()
      for _, display in ipairs({ true, false }) do
        vim.fn.delete(cache, "rf")
        local img = render([[x^2 + y^2]], display, 40)
        local pngs = vim.fn.glob(cache .. "/*.png", false, true)
        assert.are.equal(1, #pngs)
        local f = io.open(pngs[1], "rb")
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
      image.config.display_em = 1.6
      local large = render([[\frac{a+b}{2} + x^2]], true, 100)
      -- Whole-cell padding blurs the ratio by up to a cell on each side.
      assert(large.cols >= 2 * small.cols - 2 and large.cols <= 2 * small.cols, "em should scale the width")
    end)

    it("keeps display math inside the column budget by shrinking it", function()
      local img = render([[P_{\text{upset}} = \frac{1}{1 + 10^{D\sqrt{N}/2000}}]], true, 20)
      assert(img, "a formula that can shrink to fit must still render")
      assert(img.cols <= 20, "expected at most 20 columns, got " .. img.cols)
    end)

    describe("display indent", function()
      local expr = [[\frac{a+b}{2} + x^2 + y^2 + z^2]]

      it("keeps the indent when the formula does not have to shrink", function()
        local natural = render(expr, true, 100, 0).cols
        local img = render(expr, true, natural + 3, 3)
        assert.are.equal(3, img.indent)
        assert.are.equal(natural, img.cols)
      end)

      it("drops the indent when keeping it would shrink the formula", function()
        local natural = render(expr, true, 100, 0).cols
        local img = render(expr, true, natural + 1, 3)
        assert.are.equal(0, img.indent)
        assert.are.equal(natural, img.cols)
      end)

      it("drops the indent when the formula shrinks either way, since flush shrinks less", function()
        local natural = render(expr, true, 100, 0).cols
        local img = render(expr, true, natural - 4, 3)
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
        assert.are.equal(0, #vim.fn.glob(cache .. "/*.png", false, true), "no PNG should have been written")
      end)
    end)

    it("gives up cleanly (nil, so art takes over) on TeX it cannot typeset", function()
      assert.is_nil(render([[\frac{1}{]], true, 40))
    end)
  end)
end
