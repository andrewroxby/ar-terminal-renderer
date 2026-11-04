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
-- The PNGs live in the renderer's own content-keyed cache
-- ($TMPDIR/ar-term-render, shared with Pi and swept by age). This module keeps
-- only the paths in memory, so a formula costs one renderer run per session.

local api = vim.api
local uv = vim.uv
local lock = require("ar_term_render.lock")
local queue = require("ar_term_render.queue")
local server = require("ar_term_render.server")
local terminal = require("ar_term_render.terminal")

local M = {}

-- This file is <root>/nvim/lua/ar_term_render/image.lua.
local ROOT = vim.fs.dirname(vim.fs.dirname(vim.fs.dirname(vim.fs.dirname(debug.getinfo(1, "S").source:sub(2)))))

local defaults = {
  -- ar-term-render is found on PATH, else run from this checkout through node.
  ar_bin = "ar-term-render",
  ar_fallback_script = ROOT .. "/core/cli.ts",
  node = "node",
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
  -- Keep one `ar-term-render serve` process for all formulas instead of
  -- starting the renderer once per formula. A renderer without `serve` falls
  -- back to one run per formula by itself.
  persistent = true,
}

local config = vim.deepcopy(defaults)

local warned = {}
local node_checked = {}

--- Replaces the options with the defaults plus `opts`, so calling it again
--- starts from scratch. It also forgets which warnings were shown.
--- @param opts table|nil keys of `defaults`
function M.setup(opts)
  config = vim.tbl_deep_extend("force", vim.deepcopy(defaults), opts or {})
  warned = {}
  node_checked = {}
  server.reset()
end

-- Em sizes move in steps of this many device pixels.
local EM_STEP = 0.1

-- Columns a display formula may take, as in core/layout.ts: the width less
-- two and the indent, capped at 100.
local MAX_COLS = 100

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

-- ---- terminal images ----

-- Image data in the terminal, by id. `images[id]` says what the id shows,
-- `ids` finds an id by what it shows, so a formula drawn twice, or drawn
-- again after the row cache is dropped, reuses one image. `sent` holds the
-- ids whose data has reached the terminal, and `pending` those waiting on the
-- transmit lock.
local images = {}
local ids = {}
local sent = {}
local pending = {}

-- Ids must fit 24 bits so they survive as a highlight foreground colour, and
-- must avoid 0 (kitty treats it as unset).
--
-- Every program in one terminal window shares its image store, tmux panes
-- included, so each Neovim starts its run of ids at its own point in the
-- 24-bit space. Two Neovims sharing a start would overwrite each other's
-- images.
local next_id = math.floor(vim.uv.os_getpid() * 2654435761 + vim.uv.hrtime()) % 0xFFFFFF

local function allocate_id()
  next_id = next_id % 0xFFFFFF + 1
  return next_id
end

-- Kitty APC frames for a PNG, 4096 base64 bytes each, wrapped for tmux. Every
-- frame carries q=2 so the terminal never answers into the editor's input.
function M.frames(id, data, cols, rows)
  local encoded = vim.base64.encode(data)
  local frames = {}
  local offset = 1
  repeat
    local chunk = encoded:sub(offset, offset + 4095)
    offset = offset + 4096
    local more = offset <= #encoded and 1 or 0
    local control
    if #frames == 0 then
      control = string.format("a=T,U=1,i=%d,p=%d,f=100,c=%d,r=%d,q=2,m=%d", id, id, cols, rows, more)
    else
      control = string.format("q=2,m=%d", more)
    end
    frames[#frames + 1] = terminal.wrap("\027_G" .. control .. ";" .. chunk .. "\027\\")
  until offset > #encoded
  return frames
end

-- Puts an image's bytes in the terminal as inline base64, so they reach
-- remote clients too. The frames go out under the cross-process lock Pi
-- takes (see ar_term_render.lock). Answers "ok", "busy" when another process
-- holds the lock, or "gone" when the PNG is no longer there.
local function upload(id)
  local img = images[id]
  local file = io.open(img.path, "rb")
  if not file then
    return "gone"
  end
  local data = file:read("*a")
  file:close()
  if #data == 0 then
    return "gone"
  end
  local release = lock.try()
  if not release then
    return "busy"
  end
  pcall(function()
    terminal.send(table.concat(M.frames(id, data, img.cols, img.rows)))
  end)
  release()
  sent[id] = true
  pending[id] = nil
  return "ok"
end

local function forget(id)
  local img = images[id]
  if img then
    ids[img.slot] = nil
  end
  images[id] = nil
  sent[id] = nil
  pending[id] = nil
end

local retry

-- Tries the images that found the lock busy again after a short random wait,
-- so several editors that met at the same moment do not meet again. A busy
-- lock ends the round, leaving the rest for the next.
local function schedule_retry()
  if retry then
    return
  end
  retry = uv.new_timer()
  retry:start(
    100 + (uv.hrtime() % 150000000) / 1e6,
    0,
    vim.schedule_wrap(function()
      retry:close()
      retry = nil
      for id in pairs(pending) do
        local result = upload(id)
        if result == "gone" then
          forget(id)
        elseif result == "busy" then
          schedule_retry()
          return
        end
      end
    end)
  )
end

-- Starts an upload, queueing it behind the lock when that is busy. Answers
-- false when the PNG is gone.
local function start_upload(id)
  local result = upload(id)
  if result == "busy" then
    pending[id] = true
    schedule_retry()
  elseif result == "gone" then
    forget(id)
    return false
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

--- Sets every image's highlight group again. `:colorscheme` clears them,
--- and with them the ids the terminal reads from the placeholder cells.
function M.rehighlight()
  for id in pairs(images) do
    highlight_for(id)
  end
end

local function build(path, display, cols, rows)
  if cols > #DIACRITICS or rows > #DIACRITICS then
    return nil
  end
  local slot = string.format("%s:%dx%d", path, cols, rows)
  local id = ids[slot]
  if not id then
    id = allocate_id()
    ids[slot] = id
    images[id] = { path = path, cols = cols, rows = rows, slot = slot }
  end
  if not sent[id] and not pending[id] and not start_upload(id) then
    return nil
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

-- ---- renderer ----

-- Node releases that run core/cli.ts: type stripping without a flag and
-- import.meta.main arrived in 22.18 and 24.2.
local NODE_NEEDS = "Node 22.18+ or 24.2+"

local function node_supported(major, minor)
  return (major == 22 and minor >= 18) or (major == 24 and minor >= 2) or major >= 25
end

local function warn_once(key, message)
  if not warned[key] then
    warned[key] = true
    vim.notify("ar-term-render: " .. message .. "; drawing math with cellmath", vim.log.levels.WARN)
  end
end

-- Records whether `node` can run the renderer, from the answer to
-- `node --version` (res is nil when it could not be run).
local function record_node(node, res)
  local major, minor = ((res and res.code == 0 and res.stdout) or ""):match("v(%d+)%.(%d+)")
  if not major then
    warn_once("node", "node did not answer --version; the renderer needs " .. NODE_NEEDS)
    node_checked[node] = false
  elseif not node_supported(tonumber(major), tonumber(minor)) then
    warn_once("node", string.format("the renderer needs %s, found %s", NODE_NEEDS, vim.trim(res.stdout)))
    node_checked[node] = false
  else
    node_checked[node] = true
  end
end

-- Checks the node that will run the renderer, once per binary.
local function node_ok(node)
  if node_checked[node] == nil then
    local ok, res = pcall(function()
      return vim.system({ node, "--version" }, { text = true }):wait(2000)
    end)
    record_node(node, ok and res or nil)
  end
  return node_checked[node]
end

--- Starts the node check in the background, so the first formula does not
--- wait the ~40 ms it takes.
function M.prefetch()
  local node = config.node
  if node_checked[node] ~= nil then
    return
  end
  pcall(vim.system, { node, "--version" }, { text = true }, function(res)
    vim.schedule(function()
      if node_checked[node] == nil then
        record_node(node, res)
      end
    end)
  end)
end

--- The argv prefix that runs ar-term-render, or nil when it is missing or
--- node is too old for it, in which case the caller draws cellmath art.
--- Warns once either way.
function M.command()
  local argv
  local path = vim.fn.exepath(config.ar_bin)
  if path ~= "" then
    argv = { path }
  else
    local node = vim.fn.exepath(config.node)
    if node ~= "" and uv.fs_stat(config.ar_fallback_script) then
      argv = { node, config.ar_fallback_script }
    end
  end
  if not argv then
    warn_once("missing", "renderer not found")
    return nil
  end
  if not node_ok(config.node) then
    return nil
  end
  return argv
end

-- The text colour as #rrggbb, or nil when Normal has none, in which case the
-- renderer draws its own default.
function M.foreground()
  local normal = api.nvim_get_hl(0, { name = "Normal", link = false })
  if normal and normal.fg then
    return string.format("#%06x", normal.fg)
  end
  return nil
end

-- PNG paths from the renderer, by what was asked of it. `false` marks a
-- formula it rejected, so it is not asked again. A failed run is not
-- remembered.
local paths = {}

-- The renderer prints "ar-term-render: ..." and exits 1 for input it
-- refuses. Any other end, such as a node that cannot run it, is a failed run.
local function rejected(res)
  local err = res.stderr or ""
  return res.code == 1 and (res.signal or 0) == 0 and (err:find("^ar%-term%-render:") ~= nil or err:find("\nar%-term%-render:", 1, true) ~= nil)
end

-- Gets the PNG for one expression at `em` device pixels per em, asking the
-- renderer unless this session already has it, then answers through
-- cb(path) or, when there is none, cb(nil, transient). The canvas is whole
-- cells of `cell`, so the terminal places the image without stretching it and
-- the em stays true. transient says the run failed rather than the formula.
local function png(bin, expr, display, em, color, cell, cb)
  local key = table.concat({
    table.concat(bin, " "),
    lock.dir(),
    display and "d" or "i",
    string.format("%.1f", em),
    cell.w .. "x" .. cell.h,
    color or "-",
    expr,
  }, "\30")
  local known = paths[key]
  if known == false then
    cb(nil)
    return
  end
  if known and uv.fs_stat(known) then
    cb(known)
    return
  end
  queue.submit("png:" .. key, function(done)
    local function finish(out)
      if out and uv.fs_stat(out) then
        paths[key] = out
        done(out)
        return true
      end
      return false
    end

    -- One renderer run per formula: the way without a server.
    local function one_shot()
      local cmd = vim.list_extend(vim.deepcopy(bin), {
        "tex",
        display and "--display" or "--inline",
        "--em-px", string.format("%.1f", em),
        "--cell", cell.w .. "x" .. cell.h,
      })
      if color then
        vim.list_extend(cmd, { "-c", color })
      end
      vim.list_extend(cmd, { "--", expr })
      local started = pcall(vim.system, cmd, { text = true }, function(res)
        vim.schedule(function()
          local out = vim.trim(res.stdout or "")
          if res.code == 0 and (res.signal or 0) == 0 and out ~= "" and finish(out) then
            return
          elseif rejected(res) then
            paths[key] = false
            done(nil)
          else
            local line = vim.trim((res.stderr or ""):match("[^\n]*") or "")
            warn_once("failed", string.format("the renderer failed (%s); it needs %s and rsvg-convert", line ~= "" and line or "exit " .. tostring(res.code), NODE_NEEDS))
            done(nil, true)
          end
        end)
      end)
      if not started then
        done(nil, true)
      end
    end

    if not config.persistent then
      one_shot()
      return
    end
    server.request(bin, {
      tex = expr,
      display = display,
      emPx = tonumber(string.format("%.1f", em)),
      cell = cell.w .. "x" .. cell.h,
      color = color,
    }, function(res)
      if res.unavailable then
        one_shot()
      elseif res.path and finish(res.path) then
        return
      elseif res.rejected then
        paths[key] = false
        done(nil)
      else
        warn_once("failed", string.format("the renderer failed (%s); it needs %s and rsvg-convert", res.error or "no answer", NODE_NEEDS))
        done(nil, true)
      end
    end)
  end, cb)
end

--- Render one expression to placeholder rows, answering through
--- cb(img|nil, transient).
---
--- The result always fits the column budget, and inline math always fits a
--- single row. Since canvas size scales with the em, each miss yields the
--- ratio to correct by. nil means no legible size fits, and the caller draws
--- cellmath art instead. transient is true when nil came from a failed run,
--- which the caller should not remember.
---
--- Display math can ask for `indent` columns of left margin. The margin is
--- kept only when it costs the formula no size; otherwise the formula is drawn
--- flush so it can stay larger. img.indent says which, and the caller places
--- the rows that many columns in.
--- @param expr string LaTeX source, without delimiters
--- @param display boolean display style when true, inline style when false
--- @param width number window text width in columns
--- @param cb fun(img: table|nil, transient: boolean|nil)
--- @param indent number|nil left margin in columns, display math only
function M.render(expr, display, width, cb, indent)
  local bin = M.command()
  if not bin then
    cb(nil, true)
    return
  end
  if not display and requires_flat_inline(expr) then
    cb(nil)
    return
  end
  local cell = terminal.cell()
  local color = M.foreground()

  local function quantize(em)
    return tonumber(string.format("%.1f", math.floor(em / EM_STEP + 1e-6) * EM_STEP))
  end
  local start_em = quantize(cell.h * (display and config.display_em or config.inline_em))
  -- Inline math does not shrink: its floor is its start.
  local floor_em = display and quantize(cell.h * config.display_em_floor) or start_em

  -- Columns available beside `margin` blank ones. Display math leaves two
  -- columns free and stops at 100, as Pi does.
  local function budget(margin)
    if display then
      return math.max(1, math.min(math.floor(width) - 2 - margin, MAX_COLS))
    end
    return math.max(1, math.floor(width))
  end

  -- Shrinks the em until the image fits `cols` columns, then answers
  -- done(img|nil, em, transient). The image is the one drawn at that em.
  local function fit(cols_budget, done)
    local function attempt(em, passes_left)
      png(bin, expr, display, em, color, cell, function(path, transient)
        if not path then
          done(nil, nil, transient)
          return
        end
        local px_w, px_h = png_size(path)
        if not px_w then
          done(nil, nil, true)
          return
        end
        local cols = math.max(1, math.ceil(px_w / cell.w))
        local rows = math.max(1, math.ceil(px_h / cell.h))
        if cols <= cols_budget and (display or rows == 1) then
          local img = build(path, display, cols, rows)
          done(img, em, img == nil)
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
        local ratio = math.min((cols_budget * cell.w) / px_w, 0.95)
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
      end)
    end

    attempt(start_em, config.max_passes)
  end

  indent = display and math.max(0, indent or 0) or 0
  if indent <= 0 then
    fit(budget(0), function(img, _, transient)
      if img then
        img.indent = 0
      end
      cb(img, transient)
    end)
    return
  end
  fit(budget(indent), function(indented, em, indented_transient)
    if indented and em >= start_em then
      indented.indent = indent
      cb(indented)
      return
    end
    fit(budget(0), function(flush, flush_em, flush_transient)
      if flush and (not indented or flush_em > em) then
        flush.indent = 0
        cb(flush)
      elseif indented then
        indented.indent = indent
        cb(indented)
      else
        cb(nil, indented_transient or flush_transient)
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
  for id in pairs(wanted) do
    if images[id] then
      start_upload(id)
    end
  end
end

--- Drop an image from the terminal's memory, data included.
function M.delete(id)
  if not images[id] then
    return
  end
  local was_sent = sent[id]
  forget(id)
  if was_sent then
    terminal.write(string.format("\027_Ga=d,d=I,i=%d,q=2\027\\", id))
  end
end

--- Drop every image this session transmitted.
function M.delete_all()
  local all = {}
  for id in pairs(images) do
    all[#all + 1] = id
  end
  for _, id in ipairs(all) do
    M.delete(id)
  end
end

return M
