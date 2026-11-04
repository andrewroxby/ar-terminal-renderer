-- ar_term_render.image: LaTeX to kitty-graphics images for Markdown buffers.
--
-- Renders an expression to a PNG with ar-term-render's `tex` command,
-- transmits it to the terminal once, and hands back rows of Unicode
-- placeholder cells. Those rows drop straight into the same placement the
-- cellmath path uses, so the caller needs no knowledge of the graphics
-- protocol.
--
-- The renderer guarantees the raster fits the box it is given: within the
-- column budget always, and within a single row for inline math. Display
-- math shrinks until that holds and gives up rather than return something
-- that does not fit, because Neovim anchors virtual lines to buffer lines
-- rather than visual rows, and a decoration taller than its row cannot be
-- positioned on a line that soft-wraps. Everything the caller places is
-- therefore one row per source line, which wraps like any other text.
--
-- Placeholders (U+10EEEE plus row/column diacritics) let the terminal anchor
-- the image to buffer cells, so it scrolls and clips with the text. The image
-- id cannot ride in an SGR escape inside virt_text, so it travels as the
-- foreground colour of a per-image highlight group, which is how the kitty
-- protocol expects to find it.
--
-- PNGs are cached on disk by expression, size, and colour, so a formula costs
-- one subprocess the first time it is ever seen and nothing afterwards.

local api = vim.api
local uv = vim.uv
local queue = require("ar_term_render.queue")
local terminal = require("ar_term_render.terminal")

local M = {}

-- This file is <root>/nvim/lua/ar_term_render/image.lua.
local ROOT = vim.fs.dirname(vim.fs.dirname(vim.fs.dirname(vim.fs.dirname(debug.getinfo(1, "S").source:sub(2)))))

M.config = {
  -- ar-term-render is found on PATH, else run from this checkout through node.
  ar_bin = "ar-term-render",
  ar_fallback_script = ROOT .. "/core/cli.ts",
  cache_dir = vim.fn.stdpath("cache") .. "/ar-term-render",
  -- Sizes are one em in cell heights. Display math starts at display_em, as
  -- in Pi (about the size of the terminal's own letters), and shrinks to fit
  -- but never below display_em_floor. Inline math is drawn once at inline_em
  -- and goes to cellmath when it does not fit one row, because anything
  -- smaller is unreadable.
  display_em = 0.8,
  display_em_floor = 0.5,
  inline_em = 0.7,
  -- Shrink passes allowed before giving up.
  max_passes = 4,
}

-- Em sizes move in steps of this many device pixels.
local EM_STEP = 0.1

local STACKED_ENVIRONMENTS = { "matrix", "pmatrix", "bmatrix", "cases", "aligned", "array" }

-- These constructs are two-dimensional by definition. Crushing them into a
-- prose row produces technically fitting but unreadable math, so inline use
-- takes the flat solidus/text fallback deliberately. Scripts and limits are
-- still measured normally and remain images when they fit.
local function requires_flat_inline(expr)
  if expr:find("\\frac", 1, true) or expr:find("\\dfrac", 1, true) or expr:find("\\binom", 1, true) then
    return true
  end
  for _, env in ipairs(STACKED_ENVIRONMENTS) do
    if expr:match("\\begin%s*{%s*" .. env .. "%s*}") then
      return true
    end
  end
  return false
end

local PLACEHOLDER = vim.fn.nr2char(0x10EEEE)

-- Kitty's row/column diacritics, in order; cell (r,c) is the placeholder
-- followed by diacritic r then diacritic c.
local DIACRITICS = vim.split(
  "0305,030D,030E,0310,0312,033D,033E,033F,0346,034A,034B,034C,0350,0351,0352,0357,035B,0363,0364,0365,"
    .. "0366,0367,0368,0369,036A,036B,036C,036D,036E,036F,0483,0484,0485,0486,0487,0592,0593,0594,0595,0597,"
    .. "0598,0599,059C,059D,059E,059F,05A0,05A1,05A8,05A9,05AB,05AC,05AF,05C4,0610,0611,0612,0613,0614,0615,"
    .. "0616,0617,0657,0658,0659,065A,065B,065D,065E,06D6,06D7,06D8,06D9,06DA,06DB,06DC,06DF,06E0,06E1,06E2,"
    .. "06E4,06E7,06E8,06EB,06EC,0730,0732,0733,0735,0736,073A,073D,073F,0740,0741,0743,0745,0747,0749,074A,"
    .. "07EB,07EC,07ED,07EE,07EF,07F0,07F1,07F3,0816,0817,0818,0819,081B,081C,081D,081E,081F,0820,0821,0822,"
    .. "0823,0825,0826,0827,0829,082A,082B,082C,082D,0951,0953,0954,0F82,0F83,0F86,0F87,135D,135E,135F,17DD,"
    .. "193A,1A17,1A75,1A76,1A77,1A78,1A79,1A7A,1A7B,1A7C,1B6B,1B6D,1B6E,1B6F,1B70,1B71,1B72,1B73,1CD0,1CD1,"
    .. "1CD2,1CDA,1CDB,1CE0,1DC0,1DC1,1DC3,1DC4,1DC5,1DC6,1DC7,1DC8,1DC9,1DCB,1DCC,1DD1,1DD2,1DD3,1DD4,1DD5,"
    .. "1DD6,1DD7,1DD8,1DD9,1DDA,1DDB,1DDC,1DDD,1DDE,1DDF,1DE0,1DE1,1DE2,1DE3,1DE4,1DE5,1DE6,1DFE,20D0,20D1,"
    .. "20D4,20D5,20D6,20D7,20DB,20DC,20E1,20E7,20E9,20F0,2CEF,2CF0,2CF1,2DE0,2DE1,2DE2,2DE3,2DE4,2DE5,2DE6,"
    .. "2DE7,2DE8,2DE9,2DEA,2DEB,2DEC,2DED,2DEE,2DEF,2DF0,2DF1,2DF2,2DF3,2DF4,2DF5,2DF6,2DF7,2DF8,2DF9,2DFA,"
    .. "2DFB,2DFC,2DFD,2DFE,2DFF,A66F,A67C,A67D,A6F0,A6F1,A8E0,A8E1,A8E2,A8E3,A8E4,A8E5,A8E6,A8E7,A8E8,A8E9,"
    .. "A8EA,A8EB,A8EC,A8ED,A8EE,A8EF,A8F0,A8F1,AAB0,AAB2,AAB3,AAB7,AAB8,AABE,AABF,AAC1,FE20,FE21,FE22,FE23,"
    .. "FE24,FE25,FE26,10A0F,10A38,1D185,1D186,1D187,1D188,1D189,1D1AA,1D1AB,1D1AC,1D1AD,1D242,1D243,1D244",
  ","
)

local positions = setmetatable({}, {
  __index = function(t, k)
    local code = DIACRITICS[k]
    if not code then
      return nil
    end
    local char = vim.fn.nr2char(tonumber(code, 16))
    rawset(t, k, char)
    return char
  end,
})

-- ---- png ----

-- Width and height from a PNG's IHDR, which is always the first chunk.
local function png_size(path)
  local file = io.open(path, "rb")
  if not file then
    return nil
  end
  local header = file:read(24)
  file:close()
  if not header or #header < 24 or header:sub(2, 4) ~= "PNG" then
    return nil
  end
  local function be32(offset)
    local a, b, c, d = header:byte(offset, offset + 3)
    return ((a * 256 + b) * 256 + c) * 256 + d
  end
  return be32(17), be32(21)
end

-- ---- rendering ----

local sent = {}
-- Ids by content, so a formula drawn twice, or redrawn after a resize drops
-- the row cache, reuses one image in the terminal instead of orphaning the
-- old one. The path is already a hash of expression, size, and colour.
local ids = {}

-- Ids must fit 24 bits so they survive as a highlight foreground colour, and
-- must avoid 0 (kitty treats it as unset).
--
-- Every program in one terminal window shares its image store, tmux panes
-- included, so each Neovim starts its run of ids at its own point in the
-- 24-bit space. A shared fixed start let two Neovims overwrite each other's
-- images, and a formula then drew another process's picture.
local next_id = math.floor(vim.uv.os_getpid() * 2654435761 + vim.uv.hrtime()) % 0xFFFFFF

local function allocate_id()
  next_id = next_id % 0xFFFFFF + 1
  return next_id
end

local warned_missing = false

--- The argv prefix that runs ar-term-render, or nil when it is missing, in
--- which case the caller draws cellmath art. Warns once.
function M.command()
  local path = vim.fn.exepath(M.config.ar_bin)
  if path ~= "" then
    return { path }
  end
  local node = vim.fn.exepath("node")
  if node ~= "" and uv.fs_stat(M.config.ar_fallback_script) then
    return { node, M.config.ar_fallback_script }
  end
  if not warned_missing then
    warned_missing = true
    vim.notify("ar-term-render: renderer not found; drawing math with cellmath", vim.log.levels.WARN)
  end
  return nil
end

local command_stamp = {}

-- Cache keys carry the renderer's identity, so a rebuilt CLI or MathJax
-- bundle stops serving PNGs the old one drew.
local function stamp(cmd)
  local id = table.concat(cmd, " ")
  if not command_stamp[id] then
    local real = uv.fs_realpath(cmd[#cmd]) or cmd[#cmd]
    local parts = { id }
    for _, file in ipairs({ real, vim.fs.dirname(real) .. "/vendor/mathjax.cjs" }) do
      local st = uv.fs_stat(file)
      parts[#parts + 1] = st and string.format("%d:%d", st.size, st.mtime.sec) or "?"
    end
    command_stamp[id] = table.concat(parts, ":")
  end
  return command_stamp[id]
end

local function foreground()
  local normal = api.nvim_get_hl(0, { name = "Normal", link = false })
  if normal and normal.fg then
    return string.format("#%06x", normal.fg)
  end
  return "#c5c9c5"
end

local function cache_path(identity, expr, display, variant, color)
  local key = table.concat({ identity, expr, display and "d" or "i", variant, color }, "\30")
  local digest = vim.fn.sha256(key)
  return M.config.cache_dir .. "/" .. digest .. ".png"
end

-- Transmits a PNG as inline base64 so the bytes reach remote clients too, not
-- only readers of this machine's filesystem.
local function transmit(id, path, cols, rows)
  local file = io.open(path, "rb")
  if not file then
    return false
  end
  local data = file:read("*a")
  file:close()
  local encoded = vim.base64.encode(data)
  local chunk_size = 4096
  local offset = 1
  local first = true
  while offset <= #encoded do
    local chunk = encoded:sub(offset, offset + chunk_size - 1)
    offset = offset + chunk_size
    local more = offset <= #encoded and 1 or 0
    local control
    if first then
      control = string.format("a=T,U=1,i=%d,p=%d,f=100,c=%d,r=%d,q=2,m=%d", id, id, cols, rows, more)
      first = false
    else
      control = string.format("m=%d", more)
    end
    terminal.write("\027_G" .. control .. ";" .. chunk .. "\027\\")
  end
  return true
end

-- One row of placeholder cells for row `r` of a cols-wide image.
local function placeholder_row(r, cols)
  local parts = {}
  for c = 1, cols do
    parts[#parts + 1] = PLACEHOLDER .. (positions[r] or "") .. (positions[c] or "")
  end
  return table.concat(parts)
end

local function highlight_for(id)
  local name = "ArRenderImage" .. id
  -- Kitty reads the image id from foreground colour and the placement id
  -- from underline colour. They are equal here because each cached image has
  -- one placement shape.
  api.nvim_set_hl(0, name, { fg = id, sp = id, nocombine = true })
  return name
end

local function build(path, display, cols, rows)
  if cols > #DIACRITICS or rows > #DIACRITICS then
    return nil
  end
  local slot = string.format("%s:%dx%d", path, cols, rows)
  local id = ids[slot]
  if not id or not sent[id] then
    id = id or allocate_id()
    if not transmit(id, path, cols, rows) then
      return nil
    end
    ids[slot] = id
    sent[id] = true
  end
  local lines = {}
  for r = 1, rows do
    lines[r] = placeholder_row(r, cols)
  end
  return {
    id = id,
    cols = cols,
    rows = rows,
    lines = lines,
    hl = highlight_for(id),
    display = display,
  }
end

local tmp_counter = 0

-- Rasterizes to a temporary file and renames it into place, so a reader only
-- ever sees a whole PNG. `em` is one em in device pixels. The canvas is whole
-- cells, so the terminal places the image without stretching it and the em
-- stays true.
local function rasterize(bin, expr, display, em, color, path, cb)
  queue.submit(path, function(done)
    vim.fn.mkdir(M.config.cache_dir, "p")
    tmp_counter = tmp_counter + 1
    local tmp = string.format("%s.%d.%d.tmp", path, uv.os_getpid(), tmp_counter)
    local cell = terminal.cell()
    local cmd = vim.list_extend(vim.deepcopy(bin), {
      "tex",
      display and "--display" or "--inline",
      "-o", tmp,
      "-c", color,
      "--em-px", string.format("%.1f", em),
      "--cell", cell.w .. "x" .. cell.h,
      "--",
      expr,
    })
    vim.system(cmd, { text = true }, function(res)
      vim.schedule(function()
        if res.code ~= 0 or not uv.fs_stat(tmp) then
          os.remove(tmp)
          done(false)
          return
        end
        if not os.rename(tmp, path) then
          os.remove(tmp)
        end
        done(uv.fs_stat(path) ~= nil)
      end)
    end)
  end, cb)
end

--- Render one expression to placeholder rows, answering through cb(img|nil).
---
--- The result always fits `max_cols` columns, and inline math always fits a
--- single row. Since canvas size scales with the em, each miss yields the
--- ratio to correct by. nil means no legible size fits, and the caller draws
--- cellmath art instead.
---
--- Display math can ask for `indent` columns of left margin. The margin is
--- kept only when it costs the formula no size; otherwise the formula is drawn
--- flush so it can stay larger. img.indent says which, and the caller places
--- the rows that many columns in.
--- @param expr string LaTeX source, without delimiters
--- @param display boolean display style when true, inline style when false
--- @param max_cols number column budget, normally the text width
--- @param cb fun(img: table|nil)
--- @param indent number|nil left margin in columns, display math only
function M.render(expr, display, max_cols, cb, indent)
  local bin = M.command()
  if not bin or (not display and requires_flat_inline(expr)) then
    cb(nil)
    return
  end
  local cell = terminal.cell()
  local color = foreground()

  local function quantize(em)
    return tonumber(string.format("%.1f", math.floor(em / EM_STEP + 1e-6) * EM_STEP))
  end
  local start_em = quantize(cell.h * (display and M.config.display_em or M.config.inline_em))
  -- Inline math does not shrink: its floor is its start.
  local floor_em = display and quantize(cell.h * M.config.display_em_floor) or start_em

  -- Shrinks the em until the image fits `budget` columns, then answers
  -- done(img|nil, em). The image is the one drawn at that em.
  local function fit(budget, done)
    local function attempt(em, passes_left)
      local key = string.format("em%.1f@%dx%d", em, cell.w, cell.h)
      local path = cache_path(stamp(bin), expr, display, key, color)

      local function measure()
        local width, height = png_size(path)
        if not width then
          done(nil)
          return
        end
        local cols = math.max(1, math.ceil(width / cell.w))
        local rows = math.max(1, math.ceil(height / cell.h))
        if cols <= budget and (display or rows == 1) then
          done(build(path, display, cols, rows), em)
          return
        end
        if passes_left <= 0 or em <= floor_em then
          done(nil)
          return
        end
        -- Shrink by the width overflow, with a nudge past the rounding that
        -- put it over a cell boundary. The floor is a size to try, not a size
        -- to stop before, so clamp to it and only give up once the floor
        -- itself has been measured and still does not fit.
        local ratio = math.min((budget * cell.w) / width, 0.95)
        local proposed = quantize(em * ratio)
        if proposed >= em then
          proposed = quantize(em - EM_STEP)
        end
        local next_em = math.max(floor_em, proposed)
        if next_em >= em then
          done(nil)
          return
        end
        attempt(next_em, passes_left - 1)
      end

      if uv.fs_stat(path) then
        measure()
      else
        rasterize(bin, expr, display, em, color, path, function(ok)
          if ok then
            measure()
          else
            done(nil)
          end
        end)
      end
    end

    attempt(start_em, M.config.max_passes)
  end

  local flush = math.max(1, math.floor(max_cols or 80))
  indent = display and math.min(indent or 0, flush - 1) or 0
  if indent <= 0 then
    fit(flush, function(img)
      if img then
        img.indent = 0
      end
      cb(img)
    end)
    return
  end
  fit(flush - indent, function(indented, em)
    if indented and em >= start_em then
      indented.indent = indent
      cb(indented)
      return
    end
    fit(flush, function(unindented, flush_em)
      if unindented and (not indented or flush_em > em) then
        unindented.indent = 0
        cb(unindented)
      elseif indented then
        indented.indent = indent
        cb(indented)
      else
        cb(nil)
      end
    end)
  end)
end

--- Upload images again by id. Another program can clear the terminal's
--- images: tmux panes share one terminal, and a delete-all from any of them
--- (Pi's full redraw sends one) takes these along. Asking the terminal which
--- survived is not safe through tmux, whose passthrough cannot route the
--- reply, so the caller resends what is on screen.
function M.resend(wanted)
  for slot, id in pairs(ids) do
    if wanted[id] and sent[id] then
      local path, cols, rows = slot:match("^(.*):(%d+)x(%d+)$")
      transmit(id, path, tonumber(cols), tonumber(rows))
    end
  end
end

--- Drop an image from the terminal's memory.
function M.delete(id)
  if not sent[id] then
    return
  end
  sent[id] = nil
  for slot, known in pairs(ids) do
    if known == id then
      ids[slot] = nil
    end
  end
  terminal.write(string.format("\027_Ga=d,d=i,i=%d,q=2\027\\", id))
end

--- Drop every image this session transmitted.
function M.delete_all()
  for id in pairs(sent) do
    M.delete(id)
  end
end

return M
