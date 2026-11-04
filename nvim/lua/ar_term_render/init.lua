-- ar-term-render.nvim: renders LaTeX math in Markdown buffers inline, without
-- touching the file. $$...$$, \[...\] and ```math blocks become overlay rows
-- spread across the block's own lines; inline $...$ and \(...\) spans become
-- one-row inline virtual text. The cursor line always bares to raw source for
-- editing.
--
-- Two renderers, chosen per span. On a terminal that speaks the kitty
-- graphics protocol, ar_term_render.image draws real typeset math as images
-- with ar-term-render's MathJax, so it matches Pi. Anywhere else, and for
-- spans an image cannot carry (inline math too tall for one row, display math
-- wider than the window), ar_term_render.art draws Unicode text with cellmath,
-- as Pi and Claude Code do.
--
-- Architecture mirrors nvim/pack/mermaid-text: one process per expression,
-- rows cached by expression, placement identical for both renderers because
-- image rows are just strings of placeholder cells.

local api = vim.api
local art = require("ar_term_render.art")
local image = require("ar_term_render.image")
local scan = require("ar_term_render.scan")
local terminal = require("ar_term_render.terminal")

local M = {}

M.config = {
  -- Milliseconds of quiet after an edit or resize before the buffer is rescanned.
  debounce = 300,
  filetypes = { "markdown" },
  -- Draw images when the terminal supports them; false forces Unicode art.
  images = true,
  -- Display math sits display_indent columns in from the text start, as in
  -- Pi, and loses the indent when keeping it would shrink the formula.
  -- display_align = "center" centers each block instead and ignores the indent.
  display_indent = 3,
  display_align = "left",
  -- Re-upload the images on screen when the view changes, restoring any
  -- that another program cleared.
  resend = true,
  -- Milliseconds between backstop re-uploads, for a clear that lands while
  -- nothing in Neovim moves; 0 leaves only the event triggers.
  resend_every = 3000,
}

local ns = api.nvim_create_namespace("ar_term_render")
local group = api.nvim_create_augroup("ar_term_render", { clear = true })

-- Above render-markdown's default 4096, so a conceal contest over a math
-- span resolves in favour of the render. This governs conceal only: stacking
-- of display-block virt_lines on a shared row goes by creation order, not
-- priority (measured on nvim 0.12.4).
local PRIORITY = 4200

-- Per-buffer state; render cache is global, keyed by mode+width+expression.
local state = {}
local cache = {}

-- ---- rendering ----

-- cellmath does not wrap, so display art wider than the window would be cut
-- off mid-formula. Returns the indent the art can take: `want` when it fits
-- beside it, flush when only that fits, nil when it fits neither and the
-- source should stay showing. Inline art goes in as one unbroken word.
local function art_indent(rows, inline, width, want)
  if inline or not width then
    return want
  end
  local widest = 0
  for _, row in ipairs(rows) do
    widest = math.max(widest, vim.fn.strdisplaywidth(row))
  end
  if widest <= width - want then
    return want
  elseif widest <= width then
    return 0
  end
  return nil
end

-- Renders one expression, answering through cb(rows, hl, indent) where rows
-- is a list of strings and hl an optional highlight group the rows must be
-- drawn with (images carry their id in its foreground colour). rows is nil
-- when nothing could draw the expression. Answers from the global cache when
-- warm.
--
-- Images are tried first and cellmath art catches everything they cannot do:
-- a terminal without graphics, a formula the renderer rejects, or an inline
-- span too tall for one row.
--
-- Display blocks are left-aligned display_indent columns in, so they render
-- against the width left of the indent. The callback's third value is the
-- indent the rows were drawn for: both renderers drop it when they would
-- otherwise shrink or overflow.
local function render(expr, inline, width, cb)
  -- The key carries everything a render depends on: which renderer drew it,
  -- the window width, and the cell size images are measured against.
  local use_images = M.config.images and terminal.graphics()
  local cell = terminal.cell()
  local want = not inline and M.config.display_align ~= "center" and M.config.display_indent or 0
  want = math.max(0, math.min(want, (width or 0) - 1))
  local key = string.format(
    "%s:%s:%s:%dx%d:%d:%s",
    use_images and "img" or "art",
    inline and "i" or "d",
    width or 0,
    cell.w,
    cell.h,
    want,
    expr
  )
  if cache[key] ~= nil then
    local hit = cache[key]
    cb(hit.rows, hit.hl, hit.indent)
    return
  end

  local function art_render()
    art.render(expr, inline, function(rows)
      if not rows then
        -- A spawn failure is transient; do not cache it for the session.
        cb(nil, nil, want)
        return
      end
      local indent = art_indent(rows, inline, width, want)
      local entry = { rows = indent and rows, indent = indent or 0 }
      cache[key] = entry
      cb(entry.rows, nil, entry.indent)
    end)
  end

  if use_images then
    image.render(expr, not inline, width or 80, function(img)
      if img then
        cache[key] = { rows = img.lines, hl = img.hl, indent = img.indent }
        cb(img.lines, img.hl, img.indent)
      else
        art_render()
      end
    end, want)
    return
  end
  art_render()
end

-- ---- marks ----

local function win_for(buf)
  local win = api.nvim_get_current_win()
  if api.nvim_win_get_buf(win) == buf then
    return win
  end
  win = vim.fn.bufwinid(buf)
  if win == -1 then
    return nil
  end
  return win
end

local function text_area(buf)
  local win = win_for(buf)
  if not win then
    return nil, nil
  end
  local info = vim.fn.getwininfo(win)[1]
  return api.nvim_win_get_width(win) - info.textoff, info.textoff
end

-- Column, from the text start, where row r of a display block begins: the
-- block's indent, or centered when display_align asks for it.
local function display_col(block, r)
  if M.config.display_align == "center" then
    local row_width = vim.fn.strdisplaywidth(block.rows[r])
    return math.max(0, math.floor((block.rows_width - row_width) / 2))
  end
  return block.indent or 0
end

-- Spreads R render rows over the block's N lines: each line takes
-- q = ceil(R / N) rows, the first as an overlay and the rest as virtual
-- lines; a line left with none is hidden, so the block shrinks to exactly R
-- rows. Spreading matters because Neovim caps filler rows at window height.
local function display_line_opts(block, i)
  local R = #block.rows
  local q = math.ceil(R / block.n)
  local lo = (i - 1) * q + 1
  local hi = math.min(i * q, R)
  if lo > hi then
    return { conceal_lines = "", priority = PRIORITY }
  end
  local opts = {
    virt_text = { { block.rows[lo], block.hl } },
    -- win_col includes the sign/number/fold gutter; rows_width does not.
    virt_text_win_col = (block.textoff or 0) + display_col(block, lo),
    virt_text_hide = false,
    priority = PRIORITY,
  }
  if hi > lo then
    local below = {}
    for r = lo + 1, hi do
      -- In this placement path virt_lines begin at window column zero, so the
      -- gutter offset must match the overlay row's virt_text_win_col.
      local col = (block.textoff or 0) + display_col(block, r)
      below[#below + 1] = { { string.rep(" ", col) }, { block.rows[r], block.hl } }
    end
    opts.virt_lines = below
  end
  return opts
end

local function place_display_line(buf, block, i, row, line)
  local opts = {}
  for k, v in pairs(block.opts[i]) do
    opts[k] = v
  end
  if opts.virt_text and #line > 0 then
    opts.end_row = row
    opts.end_col = #line
    opts.conceal = ""
  end
  block.marks[i] = api.nvim_buf_set_extmark(buf, ns, row, 0, opts)
end

local function clear_marks(buf, block)
  for _, id in pairs(block.marks) do
    api.nvim_buf_del_extmark(buf, ns, id)
  end
  block.marks = {}
end

local function anchor_row(buf, block)
  local pos = api.nvim_buf_get_extmark_by_id(buf, ns, block.anchor, {})
  return pos[1]
end

local function apply_display(buf, block)
  clear_marks(buf, block)
  block.opts = {}
  local top = anchor_row(buf, block)
  if not top then
    return
  end
  if top + block.n > api.nvim_buf_line_count(buf) then
    return
  end
  local lines = api.nvim_buf_get_lines(buf, top, top + block.n, false)
  if table.concat(lines, "\n") ~= block.source then
    return -- a rescan is already on its way
  end
  for i = 1, block.n do
    block.opts[i] = display_line_opts(block, i)
    place_display_line(buf, block, i, top + i - 1, lines[i])
  end
end

-- Inline math is always one row, image or art, so it behaves like a word:
-- it wraps whole and needs no alignment of its own.
local function place_inline(buf, span)
  return api.nvim_buf_set_extmark(buf, ns, span.row, span.s, {
    end_col = span.e,
    virt_text = { { span.drawn, span.hl } },
    virt_text_pos = "inline",
    conceal = "",
    priority = PRIORITY,
  })
end

-- ---- cursor line ----

local refresh_row

-- Bares every mark on the cursor's row (display line or inline span) so the
-- raw source is there to edit, and restores the row it left.
local function sync_cursor(buf)
  local st = state[buf]
  if not st then
    return
  end
  local win = win_for(buf)
  if not win then
    return
  end
  local row = api.nvim_win_get_cursor(win)[1] - 1
  if st.bared == row then
    return
  end
  local prev = st.bared
  st.bared = row
  if prev then
    refresh_row(buf, prev)
  end
  refresh_row(buf, row)
end

-- Recomputes one row's decorations: bared when it is the cursor row, drawn
-- otherwise. Cheap because renders come from the cache.
refresh_row = function(buf, row)
  local st = state[buf]
  if not st or not st.enabled then
    return
  end
  for _, block in ipairs(st.displays) do
    local top = anchor_row(buf, block)
    if top and row >= top and row < top + block.n then
      local i = row - top + 1
      if block.marks[i] then
        api.nvim_buf_del_extmark(buf, ns, block.marks[i])
        block.marks[i] = nil
      end
      if row ~= st.bared and block.rows and block.opts[i] then
        local line = api.nvim_buf_get_lines(buf, row, row + 1, false)[1] or ""
        place_display_line(buf, block, i, row, line)
      end
      return
    end
  end
  for id, span in pairs(st.inline_marks) do
    if span.row == row then
      api.nvim_buf_del_extmark(buf, ns, id)
      st.inline_marks[id] = nil
    end
  end
  if row ~= st.bared then
    for _, span in ipairs(st.inlines) do
      if span.row == row and span.drawn then
        local line = api.nvim_buf_get_lines(buf, row, row + 1, false)[1]
        if line and line:sub(span.s + 1, span.e) == span.raw then
          st.inline_marks[place_inline(buf, span)] = span
        end
      end
    end
  end
end

-- ---- refresh ----

local function refresh(buf)
  local st = state[buf]
  if not st or not st.enabled or not api.nvim_buf_is_valid(buf) then
    return
  end
  local width, textoff = text_area(buf)
  if not width or width < 1 then
    return
  end
  st.generation = (st.generation or 0) + 1
  local generation = st.generation
  local lines = api.nvim_buf_get_lines(buf, 0, -1, false)
  local found_displays, found_inlines = scan.scan(lines)

  -- Display blocks keep their anchor extmarks across scans; a block whose
  -- anchor still lands on its opening row is reused, so an unchanged block
  -- does not flicker.
  local by_row = {}
  for _, block in ipairs(st.displays) do
    local top = anchor_row(buf, block)
    if top and not by_row[top] then
      by_row[top] = block
    else
      clear_marks(buf, block)
      api.nvim_buf_del_extmark(buf, ns, block.anchor)
    end
  end
  local displays = {}
  for _, f in ipairs(found_displays) do
    local block = by_row[f.open]
    by_row[f.open] = nil
    if not block then
      block = { anchor = api.nvim_buf_set_extmark(buf, ns, f.open, 0, {}), marks = {}, opts = {} }
    end
    block.n = f.close - f.open + 1
    displays[#displays + 1] = block
    local source = table.concat(vim.list_slice(lines, f.open + 1, f.close + 1), "\n")
    if block.source ~= source or block.rows_width ~= width or block.textoff ~= textoff then
      block.source = source
      block.rows_width = width
      block.textoff = textoff
      clear_marks(buf, block)
      block.opts = {}
      local submitted_source = source
      render(f.body, false, width, function(rows, hl, indent)
        if
          not api.nvim_buf_is_valid(buf)
          or state[buf] ~= st
          or block.source ~= submitted_source
        then
          return
        end
        block.rows = rows
        block.hl = hl
        block.indent = indent
        if rows then
          apply_display(buf, block)
          if st.bared then
            sync_cursor(buf)
          end
        end
      end)
    elseif block.rows and next(block.marks) == nil then
      apply_display(buf, block)
    end
  end
  for _, block in pairs(by_row) do
    clear_marks(buf, block)
    api.nvim_buf_del_extmark(buf, ns, block.anchor)
  end
  st.displays = displays

  -- Inline spans are cheap: drop every mark and re-place from the scan.
  for id in pairs(st.inline_marks) do
    api.nvim_buf_del_extmark(buf, ns, id)
  end
  st.inline_marks = {}
  st.inlines = found_inlines
  for _, span in ipairs(found_inlines) do
    span.raw = lines[span.row + 1]:sub(span.s + 1, span.e)
    render(span.body, true, width, function(rows, hl)
      if
        not api.nvim_buf_is_valid(buf)
        or state[buf] ~= st
        or st.generation ~= generation
        or not rows
        or not rows[1]
      then
        return
      end
      if span.drawn then
        return
      end
      span.drawn = rows[1]
      span.hl = hl
      if state[buf].bared ~= span.row then
        local line = api.nvim_buf_get_lines(buf, span.row, span.row + 1, false)[1]
        if line and line:sub(span.s + 1, span.e) == span.raw then
          st.inline_marks[place_inline(buf, span)] = span
        end
      end
    end)
  end
end

local function schedule_refresh(buf)
  local st = state[buf]
  if not st then
    return
  end
  st.timer:stop()
  st.timer:start(M.config.debounce, 0, vim.schedule_wrap(function()
    refresh(buf)
  end))
end

-- ---- buffer lifecycle ----

local function detach(buf)
  local st = state[buf]
  if not st then
    return
  end
  st.timer:stop()
  st.timer:close()
  state[buf] = nil
  if api.nvim_buf_is_valid(buf) then
    api.nvim_buf_clear_namespace(buf, ns, 0, -1)
  end
end

local function attach(buf)
  if state[buf] then
    return
  end
  state[buf] = {
    enabled = true,
    displays = {},
    inlines = {},
    inline_marks = {},
    bared = nil,
    timer = vim.uv.new_timer(),
    generation = 0,
  }
  local function on(events, cb)
    api.nvim_create_autocmd(events, { group = group, buffer = buf, callback = cb })
  end
  on({ "BufWinEnter", "BufWritePost", "InsertLeave" }, function()
    schedule_refresh(buf)
  end)
  on({ "TextChanged" }, function()
    schedule_refresh(buf)
  end)
  on({ "CursorMoved", "CursorMovedI" }, function()
    sync_cursor(buf)
  end)
  api.nvim_create_autocmd({ "BufWipeout", "BufDelete" }, {
    group = group,
    buffer = buf,
    once = true,
    callback = function()
      detach(buf)
    end,
  })
  refresh(buf)
end

-- ---- commands ----

-- Rows above the viewport whose display math can still draw into it.
local MARGIN = 8

-- Every image id drawn in a window's visible rows. Marks carry their image
-- in a ArRenderImage<id> highlight on virt_text or virt_lines chunks.
local function resend_visible()
  local wanted, any = {}, false
  for _, win in ipairs(api.nvim_list_wins()) do
    local buf = api.nvim_win_get_buf(win)
    if state[buf] then
      local top = math.max(0, vim.fn.line("w0", win) - 1 - MARGIN)
      local bottom = vim.fn.line("w$", win)
      for _, mark in ipairs(api.nvim_buf_get_extmarks(buf, ns, { top, 0 }, { bottom, 0 }, { details = true })) do
        local d = mark[4]
        for _, chunks in ipairs(vim.list_extend({ d.virt_text or {} }, d.virt_lines or {})) do
          for _, chunk in ipairs(chunks) do
            local id = type(chunk[2]) == "string" and chunk[2]:match("^ArRenderImage(%d+)$")
            if id then
              wanted[tonumber(id)], any = true, true
            end
          end
        end
      end
    end
  end
  if any then
    image.resend(wanted)
  end
end

local function set_enabled(buf, enabled)
  local st = state[buf]
  st.enabled = enabled
  if enabled then
    refresh(buf)
  else
    st.bared = nil
    for _, block in ipairs(st.displays) do
      clear_marks(buf, block)
    end
    for id in pairs(st.inline_marks) do
      api.nvim_buf_del_extmark(buf, ns, id)
    end
    st.inline_marks = {}
  end
end

local function command(opts)
  local buf = api.nvim_get_current_buf()
  if not state[buf] then
    attach(buf)
  end
  local st = state[buf]
  local sub = opts.fargs[1] or "toggle"
  if sub == "toggle" then
    set_enabled(buf, not st.enabled)
  elseif sub == "on" then
    set_enabled(buf, true)
  elseif sub == "off" then
    set_enabled(buf, false)
  elseif sub == "render" then
    st.enabled = true
    refresh(buf)
  else
    vim.notify("ar-term-render: unknown subcommand " .. sub, vim.log.levels.ERROR)
  end
end

-- ---- setup ----

function M.setup(opts)
  M.config = vim.tbl_deep_extend("force", M.config, opts or {})
  api.nvim_create_autocmd("FileType", {
    group = group,
    pattern = M.config.filetypes,
    callback = function(ev)
      attach(ev.buf)
    end,
  })
  -- A width change re-breaks display math, and a resize can change the cell
  -- pixel size, which decides how many cells an image covers.
  api.nvim_create_autocmd({ "WinResized", "VimResized" }, {
    group = group,
    callback = function()
      terminal.invalidate_cell()
      cache = {}
      for buf in pairs(state) do
        if api.nvim_buf_is_valid(buf) then
          schedule_refresh(buf)
        end
      end
    end,
  })

  -- Re-upload the images on screen whenever the view changes or comes back,
  -- since another program may have cleared them (see image.resend): Pi's
  -- full redraw and yazi's preview erase both delete every image in the
  -- terminal. A slow backstop catches a clear that lands while nothing
  -- moves. A re-upload is idempotent and takes ~2 ms to prepare; the short
  -- wait folds a burst of scroll events into one.
  if M.config.resend then
    local timer = vim.uv.new_timer()
    local function soon()
      timer:stop()
      timer:start(50, 0, vim.schedule_wrap(resend_visible))
    end
    api.nvim_create_autocmd(
      { "BufWinEnter", "FocusGained", "WinScrolled", "WinResized", "VimResized", "CursorHold" },
      { group = group, callback = soon }
    )
    -- For callers that know a clear just happened, such as the yazi column
    -- coming back after yazi erased an image preview.
    api.nvim_create_autocmd("User", { group = group, pattern = "ArRenderResend", callback = soon })
    if M.config.resend_every > 0 then
      local backstop = vim.uv.new_timer()
      backstop:start(M.config.resend_every, M.config.resend_every, vim.schedule_wrap(resend_visible))
    end
  end

  -- Images live in the terminal, not the buffer, so they outlast nvim unless
  -- they are dropped on the way out.
  api.nvim_create_autocmd("VimLeavePre", {
    group = group,
    callback = function()
      image.delete_all()
    end,
  })
  api.nvim_create_user_command("ArRender", command, {
    nargs = "?",
    complete = function()
      return { "toggle", "on", "off", "render" }
    end,
  })
  for _, buf in ipairs(api.nvim_list_bufs()) do
    if api.nvim_buf_is_loaded(buf) and vim.tbl_contains(M.config.filetypes, vim.bo[buf].filetype) then
      attach(buf)
    end
  end
end

return M
