-- 体系文件版式过滤器（pandoc → Word）：
--   以「1.2　」「6.1.3　」这样的条款编号开头的段落用 Clause 样式（顶格，不缩进）；
--   a) b) c) 这类有序列表转成带编号文字的段落，用 Item 样式（悬挂缩进），不用 Word 自动编号；
--   无序列表转成逐行排列的段落，用 ListPlain 样式（顶格，不加项目符号）；
--   紧跟在表格后面的段落用 AfterTable 样式（段前留空）。

local function is_clause(el)
  local first = el.content[1]
  return first and first.t == 'Str' and first.text:match('^%d+%.%d+[%.%d]*　') ~= nil
end

function Para(el)
  if is_clause(el) then
    return pandoc.Div({ el }, { ['custom-style'] = 'Clause' })
  end
end

local function label(n, style, delim)
  local s
  if style == 'LowerAlpha' then
    s = string.char(96 + n)
  elseif style == 'UpperAlpha' then
    s = string.char(64 + n)
  else
    s = tostring(n)
  end
  if delim == 'OneParen' then
    return s .. ')'
  elseif delim == 'TwoParens' then
    return '(' .. s .. ')'
  end
  return s .. '.'
end

-- 把列表项的块展开成段落；第一段前面加上前缀
local function item_blocks(blocks, prefix, style)
  local out = {}
  for i, b in ipairs(blocks) do
    if b.t == 'Para' or b.t == 'Plain' then
      local inlines = pandoc.List(b.content)
      if i == 1 and prefix then
        inlines:insert(1, pandoc.Space())
        inlines:insert(1, pandoc.Str(prefix))
      end
      out[#out + 1] = pandoc.Div({ pandoc.Para(inlines) }, { ['custom-style'] = style })
    else
      out[#out + 1] = b
    end
  end
  return out
end

function OrderedList(el)
  local attrs = el.listAttributes
  local out = {}
  for i, item in ipairs(el.content) do
    for _, b in ipairs(item_blocks(item, label(attrs.start + i - 1, attrs.style, attrs.delimiter), 'Item')) do
      out[#out + 1] = b
    end
  end
  return out
end

function BulletList(el)
  local out = {}
  for _, item in ipairs(el.content) do
    for _, b in ipairs(item_blocks(item, nil, 'ListPlain')) do
      out[#out + 1] = b
    end
  end
  return out
end

function Blocks(blocks)
  for i = 2, #blocks do
    if blocks[i].t == 'Para' and blocks[i - 1].t == 'Table' then
      blocks[i] = pandoc.Div({ blocks[i] }, { ['custom-style'] = 'AfterTable' })
    end
  end
  return blocks
end
