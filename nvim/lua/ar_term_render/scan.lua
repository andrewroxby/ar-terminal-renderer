-- ar_term_render.scan: finds math in Markdown lines. Pure, with no Neovim
-- state, so the specs can feed it plain tables.

local M = {}

local function fence_marker(line)
  return line:match("^%s*```") and "```" or line:match("^%s*~~~") and "~~~" or nil
end

-- A ```math fence is display math wearing a code fence, the form GitHub and
-- Obsidian both use. Other fences stay code.
local function math_fence(line)
  return line:match("^%s*```%s*math%s*$") ~= nil or line:match("^%s*~~~%s*math%s*$") ~= nil
end

-- render-markdown rebuilds table cells from their registered widths, and a
-- virtual replacement it does not know about throws that arithmetic off, so
-- math inside a table row is left as source.
local function table_row(line)
  return line:match("^%s*|") ~= nil
end

-- Pandoc-style guards keep currency ("$5 and $10") from matching as math:
-- the opening $ needs a non-space after it, the closing $ a non-space before
-- it and no digit after it.
local function inline_open_ok(line, i)
  local next_ch = line:sub(i + 1, i + 1)
  return next_ch ~= "" and not next_ch:match("%s")
end

local function inline_close_ok(line, i)
  local prev_ch = line:sub(i - 1, i - 1)
  local next_ch = line:sub(i + 1, i + 1)
  return prev_ch ~= "" and not prev_ch:match("%s") and not next_ch:match("%d")
end

local function contains_unescaped_dollar(text)
  local at = 1
  while true do
    at = text:find("$", at, true)
    if not at then
      return false
    end
    local escapes = 0
    local before = at - 1
    while before > 0 and text:sub(before, before) == "\\" do
      escapes = escapes + 1
      before = before - 1
    end
    if escapes % 2 == 0 then
      return true
    end
    at = at + 1
  end
end

-- Finds inline $...$ and \(...\) spans on one line, skipping `code` spans.
-- Returns a list of { s = start col, e = end col (both 0-based, end-exclusive
-- over the full delimiter), body = inner text }.
local function scan_inline(line)
  local spans = {}
  local i = 1
  local n = #line
  while i <= n do
    local ch = line:sub(i, i)
    if ch == "`" then
      local ticks = line:match("^`+", i)
      local close = line:find(ticks, i + #ticks, true)
      i = close and close + #ticks or n + 1
    elseif ch == "\\" and line:sub(i + 1, i + 1) == "(" then
      local close = line:find("\\)", i + 2, true)
      if close then
        spans[#spans + 1] = { s = i - 1, e = close + 1, body = line:sub(i + 2, close - 1) }
        i = close + 2
      else
        i = i + 2
      end
    elseif ch == "$" and line:sub(i + 1, i + 1) ~= "$" and inline_open_ok(line, i) then
      local j = i + 1
      local close
      local invalid_opener = false
      while j <= n do
        local at = line:find("%$", j)
        if not at then
          break
        end
        if line:sub(at - 1, at - 1) ~= "\\" and line:sub(at + 1, at + 1) ~= "$" and inline_close_ok(line, at) then
          local body = line:sub(i + 1, at - 1)
          if contains_unescaped_dollar(body) then
            invalid_opener = true
          else
            close = at
          end
          break
        end
        j = at + 1
      end
      if invalid_opener then
        i = i + 1
      elseif close then
        spans[#spans + 1] = { s = i - 1, e = close, body = line:sub(i + 1, close - 1) }
        i = close + 1
      else
        i = i + 1
      end
    else
      i = i + 1
    end
  end
  return spans
end

-- Finds the line closing a $$ or \[ block that opened on the line before
-- `from`: the first line matching `closer`, or nil when a blank line or the
-- end of the buffer comes first. Pi leaves a block with a blank line inside
-- as text, and so does this.
local function block_end(lines, from, closer)
  for j = from, #lines do
    if lines[j]:match(closer) then
      return j
    end
    if lines[j]:match("^%s*$") then
      return nil
    end
  end
  return nil
end

-- Scans buffer lines for math. Returns:
--   displays: { open, close, body (joined lines) } — 0-based rows, close
--     inclusive, covering the $$ or \[ \] fence lines themselves so the block
--     collapses to its render.
--   inlines: { row, s, e, body } — 0-based row, 0-based cols as in scan_inline.
-- Fenced code blocks are skipped entirely.
function M.scan(lines)
  local displays = {}
  local inlines = {}
  local i, n = 1, #lines
  local fence = nil
  while i <= n do
    local line = lines[i]
    local marker = fence_marker(line)
    if marker and fence == nil and math_fence(line) then
      -- Consume the whole fence, so the block collapses to its render the
      -- same way a $$ block does.
      local j = i + 1
      while j <= n and not lines[j]:match("^%s*" .. marker) do
        j = j + 1
      end
      if j > n then
        -- Malformed opener stays source, but must not disable every valid
        -- formula below it.
        i = i + 1
      else
        local body = {}
        for k = i + 1, j - 1 do
          body[#body + 1] = lines[k]
        end
        displays[#displays + 1] = { open = i - 1, close = j - 1, body = table.concat(body, "\n") }
        i = j + 1
      end
    elseif marker then
      if fence == nil then
        fence = marker
      elseif fence == marker then
        fence = nil
      end
      i = i + 1
    elseif fence then
      i = i + 1
    elseif line:match("^%s*%$%$") then
      -- Single-line $$...$$ or a fence opening a multi-line block.
      local rest = line:match("^%s*%$%$(.*)$")
      local same_line_close = rest:find("%$%$%s*$")
      if same_line_close and #rest >= 2 then
        displays[#displays + 1] = { open = i - 1, close = i - 1, body = rest:sub(1, same_line_close - 1) }
        i = i + 1
      else
        local j = block_end(lines, i + 1, "^%s*%$%$%s*$")
        if not j then
          i = i + 1
        else
          local body = {}
          for k = i + 1, j - 1 do
            body[#body + 1] = lines[k]
          end
          displays[#displays + 1] = { open = i - 1, close = j - 1, body = table.concat(body, "\n") }
          i = j + 1
        end
      end
    elseif line:match("^%s*\\%[%s*$") then
      local j = block_end(lines, i + 1, "^%s*\\%]%s*$")
      if not j then
        i = i + 1
      else
        local body = {}
        for k = i + 1, j - 1 do
          body[#body + 1] = lines[k]
        end
        displays[#displays + 1] = { open = i - 1, close = j - 1, body = table.concat(body, "\n") }
        i = j + 1
      end
    elseif table_row(line) then
      i = i + 1
    else
      for _, span in ipairs(scan_inline(line)) do
        inlines[#inlines + 1] = { row = i - 1, s = span.s, e = span.e, body = span.body }
      end
      i = i + 1
    end
  end
  return displays, inlines
end

return M
