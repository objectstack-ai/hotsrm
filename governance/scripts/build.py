#!/usr/bin/env python3
"""生成体系文件：模板 + 组织信息 + 参数 → Markdown → Word。

    # 标准版预览（示例组织、示例参数）
    python3 governance/scripts/build.py --packs bulk,hazmat --out build/governance

    # 客户实例（在客户私有仓库中调用，见 governance/README.md §5）
    python3 <hotsrm>/governance/scripts/build.py --instance governance

    # 只检查模板、参数、覆盖与待确认标注，不生成文件
    python3 governance/scripts/build.py --instance governance --check

依赖：Python 3.9+、PyYAML、pandoc 3。
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
GOV = HERE.parent
ROOT = GOV.parent
PACKS = ('bulk', 'hazmat', 'soe')

FRONT_RE = re.compile(r'\A---\n(.*?)\n---\n', re.DOTALL)
PACK_SUFFIX_RE = re.compile(r'^(.*\S)[ \t]*<!-- pack:([^>]*?) -->[ \t]*$')
PACK_BLOCK_RE = re.compile(r'^[ \t]*<!-- pack:([^>]*?) -->[ \t]*\n(.*?)^[ \t]*<!-- /pack -->[ \t]*\n', re.MULTILINE | re.DOTALL)
PACK_INLINE_RE = re.compile(r'<!-- pack:([^>]*?) -->(.*?)<!-- /pack -->')
BLOCK_BLOCK_RE = re.compile(r'^[ \t]*<!-- block:([a-z0-9-]+) -->[ \t]*\n(.*?)^[ \t]*<!-- /block -->[ \t]*\n',
                            re.MULTILINE | re.DOTALL)
BLOCK_INLINE_RE = re.compile(r'<!-- block:([a-z0-9-]+) -->(.*?)<!-- /block -->')
VAR_RE = re.compile(r'\{\{\s*(param|org|doc)\.([^}\s]+)\s*\}\}')
DOC_REF_RE = re.compile(r'^([A-Z]{2}-\d{2})(?:\.(title|number))?$')
PENDING_RE = re.compile(r'【待确认[^】]*】')
COMMENT_RE = re.compile(r'<!--.*?-->', re.DOTALL)
SPAN_ATTR_RE = re.compile(r'\{custom-style="[^"]*"\}')
PARAM_MARK = '\ue000'  # 待确认参数的「【待确认】」字样先用占位符，避免被当成正文标注重复计入清单


class BuildError(Exception):
    pass


def load_yaml(path: Path, default=None):
    if not path.exists():
        return default
    with path.open(encoding='utf-8') as f:
        data = yaml.safe_load(f)
    return default if data is None else data


def deep_merge(base: dict, over: dict) -> dict:
    out = dict(base)
    for k, v in (over or {}).items():
        out[k] = deep_merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


def lookup(data, dotted: str, what: str):
    cur = data
    for part in dotted.split('.'):
        if not isinstance(cur, dict) or part not in cur:
            raise BuildError(f'{what}中没有 {dotted}')
        cur = cur[part]
    return cur


def split_front(text: str, name: str) -> tuple[dict, str]:
    m = FRONT_RE.match(text)
    if not m:
        raise BuildError(f'{name} 缺少文件头（--- … ---）')
    return yaml.safe_load(m.group(1)) or {}, text[m.end():]


def pending(text: str) -> str:
    text = str(text).replace('[', r'\[').replace(']', r'\]')
    return f'[{text}]{{custom-style="Pending"}}'


def cell(value) -> str:
    return str(value).replace('|', r'\|').replace('\n', ' ')


def md_table(header: list, rows: list, ratios: list) -> str:
    """生成管道表格；分隔行的短横线数量决定列宽比例（配合 pandoc --columns）。"""
    lines = ['| ' + ' | '.join(cell(h) for h in header) + ' |',
             '|' + '|'.join('-' * (r * 4) for r in ratios) + '|']
    lines += ['| ' + ' | '.join(cell(c) for c in row) + ' |' for row in rows]
    return '\n'.join(lines) + '\n'


def div(style: str, text: str) -> str:
    return f'::: {{custom-style="{style}"}}\n{text}\n:::\n'


class Context:
    def __init__(self, instance: Path | None, packs: list[str]):
        self.instance = instance
        self.index = load_yaml(GOV / 'templates' / 'index.yaml')
        self.org = load_yaml(GOV / 'org.example.yaml', {})
        self.defs: dict[str, dict] = {}
        self.param_pack: dict[str, str] = {}
        for f in sorted((ROOT / 'params').glob('*.yaml')):
            for key, d in (load_yaml(f, {}) or {}).items():
                if key in self.defs:
                    raise BuildError(f'参数 {key} 重复定义（{f.name}）')
                self.defs[key] = d
                self.param_pack[key] = f.stem
        self.values: dict = {}
        self.pending_keys: set[str] = set()
        self.doc_meta: dict = {}
        self.numbering_pending = False
        self.notes: dict = {}
        self.warnings: list[str] = []
        self.pending_items: list[tuple[str, str, str]] = []
        self.pending_seen: set[tuple[str, str]] = set()

        if instance:
            self.org = deep_merge(self.org, load_yaml(instance / 'org.yaml', {}))
            pv = load_yaml(instance / 'params.yaml', {}) or {}
            unknown = set(pv) - {'confirmed', 'pending'}
            if unknown:
                raise BuildError(f'params.yaml 只能有 confirmed 和 pending 两节，多了 {sorted(unknown)}')
            for section in ('confirmed', 'pending'):
                for key, value in (pv.get(section) or {}).items():
                    if key not in self.defs:
                        raise BuildError(f'params.yaml 中的 {key} 没有在 hotsrm params/ 中定义')
                    if key in self.values:
                        raise BuildError(f'params.yaml 中的 {key} 同时出现在 confirmed 和 pending')
                    self.values[key] = value
                    if section == 'pending':
                        self.pending_keys.add(key)
            packs = (load_yaml(instance / 'packs.yaml', {}) or {}).get('packs') or []
            docs = load_yaml(instance / 'documents.yaml', {}) or {}
            self.numbering_pending = bool(docs.get('numbering_pending'))
            self.doc_meta = docs.get('documents') or {}
            self.notes = load_yaml(instance / 'pending.yaml', {}) or {}
        bad = set(packs) - set(PACKS)
        if bad:
            raise BuildError(f'未知的扩展包 {sorted(bad)}，可选 {PACKS}')
        self.packs = set(packs)
        for code in self.doc_meta:
            if code not in self.registry():
                raise BuildError(f'documents.yaml 中的 {code} 不在模板登记表中')

    def registry(self) -> dict:
        return {**self.index['documents'], **self.index['forms']}

    # ---- 条件 ----
    def pack_on(self, spec: str) -> bool:
        pos, neg = [], []
        for tok in (t.strip() for t in spec.split(',')):
            name = tok.lstrip('!')
            if name not in PACKS:
                raise BuildError(f'条件块中未知的扩展包 {name}')
            (neg if tok.startswith('!') else pos).append(name)
        if any(n in self.packs for n in neg):
            return False
        return not pos or any(p in self.packs for p in pos)

    # ---- 取值 ----
    def fmt_param(self, key: str, value) -> str:
        fmt = self.defs[key].get('format', '{}')
        if isinstance(value, list):
            return '、'.join(fmt.format(v) for v in value)
        return fmt.format(value)

    def param(self, dotted: str, doc: str) -> str:
        key, _, sub = dotted.partition('.')
        if key not in self.defs:
            raise BuildError(f'参数 {key} 没有在 params/ 中定义')
        if self.param_pack[key] != 'core' and self.param_pack[key] not in self.packs:
            raise BuildError(f'参数 {key} 属于未组合的扩展包 {self.param_pack[key]}，应放在条件块中')
        value = self.values.get(key, self.defs[key]['example'])
        if sub:
            value = lookup(value, sub, f'参数 {key} ')
        text = self.fmt_param(key, value)
        if key in self.pending_keys:
            # 每个文件中第一次出现时加「【待确认】」字样（黑白打印也能看出），之后只标黄
            where = '、'.join(u.split(' ', 1)[1] for u in self.defs[key].get('used_in', [])
                             if u.startswith(doc + ' ') and ' ' in u)
            self.pending_items.append((doc, f'参数：{self.defs[key]["label"]}' + (f'（{where}）' if where else ''),
                                       f'建议 {self.display(key)}'))
            first = (doc, key) not in self.pending_seen
            self.pending_seen.add((doc, key))
            return pending(text + (PARAM_MARK if first else ''))
        return text

    def doc_ref(self, ref: str) -> str:
        m = DOC_REF_RE.match(ref)
        if not m:
            raise BuildError(f'无法识别的文件引用 doc.{ref}')
        code, part = m.groups()
        entry = self.registry().get(code)
        if not entry:
            raise BuildError(f'{code} 不在模板登记表中')
        if entry['pack'] != 'core' and entry['pack'] not in self.packs:
            raise BuildError(f'引用了未组合的扩展包文件 {code}，应放在条件块中')
        meta = self.doc_meta.get(code) or {}
        if self.instance and not meta:
            self.warnings.append(f'{code}《{entry["title"]}》被引用，但没有在 documents.yaml 登记')
        number = meta.get('number') or f'{self.org.get("doc_prefix", "")}{code}'
        title = meta.get('title') or entry['title']
        if part == 'title':
            return f'《{title}》'
        if part == 'number':
            return number
        return f'{number}《{title}》'

    # ---- 渲染 ----
    def display(self, key: str) -> str:
        value = self.values.get(key, self.defs[key]['example'])
        d = self.defs[key]
        if isinstance(value, dict):
            if 'display' in d:
                return d['display'].format(**value)
            return '；'.join(f'{k}：{self.fmt_param(key, v)}' for k, v in value.items())
        unit = f' {d["unit"]}' if d.get('unit') and 'format' not in d else ''
        return self.fmt_param(key, value) + unit

    def render(self, code: str, body: str, overrides: Path | None, is_body: bool = True) -> str:
        """is_body=False 用于封面：不套用待确认标注，也不计入待确认事项清单。"""
        used_blocks: set[str] = set()

        def block(m):
            name, default = m.group(1), m.group(2)
            used_blocks.add(name)
            f = overrides / f'{name}.md' if overrides else None
            if not f or not f.exists():
                return default
            text = f.read_text(encoding='utf-8').strip()
            multiline = m.group(0).endswith('\n')
            return (text + '\n' if text else '') if multiline else text

        body = BLOCK_BLOCK_RE.sub(block, body)
        body = BLOCK_INLINE_RE.sub(block, body)
        if overrides and overrides.exists():
            for f in overrides.glob('*.md'):
                if f.stem not in used_blocks:
                    raise BuildError(f'覆盖文件 {f} 在模板 {code} 中没有对应的 block')

        lines = []
        for line in body.split('\n'):
            m = PACK_SUFFIX_RE.match(line)
            if m and '<!-- /pack -->' not in line:
                if self.pack_on(m.group(2)):
                    lines.append(m.group(1))
            else:
                lines.append(line)
        body = '\n'.join(lines)
        body = PACK_BLOCK_RE.sub(lambda m: m.group(2) if self.pack_on(m.group(1)) else '', body)
        body = PACK_INLINE_RE.sub(lambda m: m.group(2) if self.pack_on(m.group(1)) else '', body)

        def var(m):
            kind, ref = m.groups()
            if kind == 'param':
                return self.param(ref, code)
            if kind == 'org':
                return str(lookup(self.org, ref, '组织信息'))
            return self.doc_ref(ref)

        body = VAR_RE.sub(var, body)

        for n in (self.notes.get(code) or []) if is_body else []:
            after, note = n['after'], n.get('note') or ''
            count = body.count(after)
            if count != 1:
                raise BuildError(f'{code} 的待确认标注「{after}」在文中出现 {count} 次，必须正好 1 次')
            i = body.index(after) + len(after)
            body = body[:i] + (f'【待确认：{note}】' if note else '【待确认】') + body[i:]

        for m in PENDING_RE.finditer(body) if is_body else []:
            before = SPAN_ATTR_RE.sub('', body[max(0, m.start() - 80):m.start()]).replace(PARAM_MARK, '')
            before = re.sub(r'[\s|*#>\[\]{}"=-]+', ' ', before).strip()[-24:]
            self.pending_items.append((code, f'…{before}', m.group(0)))
        body = PENDING_RE.sub(lambda m: pending(m.group(0)), body).replace(PARAM_MARK, '【待确认】')

        leftover = re.search(r'\{\{|<!-- */?(pack|block)', body)
        if leftover:
            ctx = body[max(0, leftover.start() - 40):leftover.start() + 40]
            raise BuildError(f'{code} 中有未处理的标记：{ctx!r}')
        return COMMENT_RE.sub('', body)


def cover(ctx: Context, code: str, front: dict) -> tuple[str, str, str]:
    """返回（封面 Markdown、页眉右侧文字、输出文件名主干）。"""
    meta = ctx.doc_meta.get(code) or {}
    title = meta.get('title') or front.get('title') or code
    status = front.get('status') or meta.get('status') or ('示例' if not ctx.instance else '草稿')
    number = meta.get('number') or front.get('number') or f'{ctx.org.get("doc_prefix", "")}{code}'
    parts = [div('CoverCompany', ctx.org['company_name']), div('CoverTitle', title),
             div('CoverSubtitle', f'（{status}）')]

    control = front.get('control')
    if control is None:
        effective = meta.get('effective')
        control = [
            ['文件编号', number + ('【待确认】' if ctx.numbering_pending else '')],
            ['版本 / 修订', meta.get('version', '')],
            ['受控状态', status],
            ['生效日期', effective if effective else '【待确认】' if ctx.instance else ''],
            ['编制', meta.get('prepared_by', '')], ['审核', meta.get('reviewed_by', '')],
            ['批准', meta.get('approved_by', '')], ['分发范围', meta.get('distribution', '')],
        ]
    rows = []
    for i in range(0, len(control), 2):
        a = control[i]
        b = control[i + 1] if i + 1 < len(control) else ['', '']
        rows.append([f'**{a[0]}**', a[1], f'**{b[0]}**' if b[0] else '', b[1]])
    parts.append(md_table(['', '', '', ''], rows, [9, 16, 9, 16]))

    revisions = front.get('revisions', meta.get('revisions'))
    if revisions:
        parts.append(md_table(['版本', '日期', '修订内容', '修订人'], revisions, [2, 3, 8, 3]))

    header = front.get('header') or f'{number} {title}（{status}）'
    stem = front.get('file') or f'{number.replace("/", "-")} {title}（{status}）'
    return '\n'.join(parts), header, stem


# ---- Word 样式 ----

def _font(name: str) -> str:
    return f'<w:rFonts w:ascii="{name}" w:hAnsi="{name}" w:eastAsia="{name}" w:cs="{name}"/>'


def styles_xml(body_font: str, head_font: str) -> dict[str, str]:
    def para(sid, name, ppr='', rpr='', based='Normal', extra=''):
        return (f'<w:style w:type="paragraph" w:customStyle="1" w:styleId="{sid}"><w:name w:val="{name}"/>'
                f'<w:basedOn w:val="{based}"/>{extra}<w:qFormat/><w:pPr>{ppr}</w:pPr><w:rPr>{rpr}</w:rPr></w:style>')

    def heading(level, size):
        return (f'<w:style w:type="paragraph" w:styleId="Heading{level}"><w:name w:val="heading {level}"/>'
                f'<w:basedOn w:val="Normal"/><w:next w:val="BodyText"/><w:uiPriority w:val="9"/><w:qFormat/>'
                f'<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="{240 if level == 1 else 160}" w:after="120" '
                f'w:line="360" w:lineRule="auto"/><w:jc w:val="left"/><w:outlineLvl w:val="{level - 1}"/></w:pPr>'
                f'<w:rPr>{_font(head_font)}<w:b/><w:bCs/><w:color w:val="000000"/><w:sz w:val="{size}"/>'
                f'<w:szCs w:val="{size}"/></w:rPr></w:style>')

    border = '<w:{0} w:val="single" w:sz="4" w:space="0" w:color="808080"/>'
    borders = ''.join(border.format(s) for s in ('top', 'left', 'bottom', 'right', 'insideH', 'insideV'))
    line = '<w:spacing w:before="0" w:after="60" w:line="360" w:lineRule="auto"/>'
    return {
        'Normal': (f'<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/>'
                   f'<w:pPr>{line}<w:jc w:val="both"/></w:pPr><w:rPr>{_font(body_font)}<w:sz w:val="24"/>'
                   f'<w:szCs w:val="24"/></w:rPr></w:style>'),
        'BodyText': (f'<w:style w:type="paragraph" w:styleId="BodyText"><w:name w:val="Body Text"/>'
                     f'<w:basedOn w:val="Normal"/><w:qFormat/><w:pPr>{line}<w:ind w:firstLine="480"/></w:pPr></w:style>'),
        'FirstParagraph': para('FirstParagraph', 'First Paragraph', based='BodyText'),
        'Compact': para('Compact', 'Compact', '<w:spacing w:before="0" w:after="0" w:line="300" w:lineRule="auto"/>'
                        '<w:ind w:firstLine="0"/><w:jc w:val="left"/>', '<w:sz w:val="20"/><w:szCs w:val="20"/>'),
        'Heading1': heading(1, 30), 'Heading2': heading(2, 26), 'Heading3': heading(3, 24),
        'Clause': para('Clause', 'Clause', '<w:ind w:left="0" w:firstLine="0"/>'),
        'Item': para('Item', 'Item', '<w:spacing w:before="0" w:after="40" w:line="360" w:lineRule="auto"/>'
                     '<w:ind w:left="840" w:hanging="360"/>'),
        'ListPlain': para('ListPlain', 'List Plain', '<w:ind w:left="0" w:firstLine="0"/>'),
        'AfterTable': para('AfterTable', 'After Table', '<w:spacing w:before="120" w:after="60" w:line="360" w:lineRule="auto"/>',
                           based='BodyText'),
        'CoverCompany': para('CoverCompany', 'Cover Company', '<w:spacing w:before="120" w:after="120"/><w:jc w:val="center"/>',
                             f'{_font(head_font)}<w:b/><w:sz w:val="36"/><w:szCs w:val="36"/>'),
        'CoverTitle': para('CoverTitle', 'Cover Title', '<w:spacing w:before="120" w:after="120"/><w:jc w:val="center"/>',
                           f'{_font(head_font)}<w:b/><w:sz w:val="32"/><w:szCs w:val="32"/>'),
        'CoverSubtitle': para('CoverSubtitle', 'Cover Subtitle', '<w:spacing w:before="0" w:after="240"/><w:jc w:val="center"/>'),
        'Pending': ('<w:style w:type="character" w:customStyle="1" w:styleId="Pending"><w:name w:val="Pending"/>'
                    '<w:qFormat/><w:rPr><w:shd w:val="clear" w:color="auto" w:fill="FFF200"/></w:rPr></w:style>'),
        'Table': (f'<w:style w:type="table" w:default="1" w:styleId="Table"><w:name w:val="Table"/>'
                  f'<w:basedOn w:val="TableNormal"/><w:qFormat/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/>'
                  f'<w:tblBorders>{borders}</w:tblBorders><w:tblCellMar><w:top w:w="60" w:type="dxa"/>'
                  f'<w:left w:w="100" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="100" w:type="dxa"/>'
                  f'</w:tblCellMar></w:tblPr><w:tcPr><w:vAlign w:val="center"/></w:tcPr>'
                  f'<w:tblStylePr w:type="firstRow"><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:b/></w:rPr>'
                  f'<w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="D9E2F3"/></w:tcPr></w:tblStylePr></w:style>'),
    }


HEADER_XML = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
              '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
              '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="000000"/></w:pBdr>'
              '<w:tabs><w:tab w:val="right" w:pos="9070"/></w:tabs><w:spacing w:after="0"/></w:pPr>'
              '<w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">{{header_left}}</w:t></w:r>'
              '<w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:tab/><w:t xml:space="preserve">{{header_right}}</w:t></w:r>'
              '</w:p></w:hdr>')

FOOTER_XML = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
              '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
              '<w:p><w:pPr><w:jc w:val="center"/></w:pPr>'
              '<w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">第 </w:t></w:r>'
              '<w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:fldChar w:fldCharType="begin"/></w:r>'
              '<w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>'
              '<w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:fldChar w:fldCharType="separate"/></w:r>'
              '<w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t>1</w:t></w:r>'
              '<w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:fldChar w:fldCharType="end"/></w:r>'
              '<w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve"> 页 共 </w:t></w:r>'
              '<w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:fldChar w:fldCharType="begin"/></w:r>'
              '<w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:instrText xml:space="preserve"> NUMPAGES </w:instrText></w:r>'
              '<w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:fldChar w:fldCharType="separate"/></w:r>'
              '<w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t>1</w:t></w:r>'
              '<w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:fldChar w:fldCharType="end"/></w:r>'
              '<w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve"> 页</w:t></w:r>'
              '</w:p></w:ftr>')

SECT_PR = ('<w:sectPr><w:headerReference w:type="default" r:id="rIdHotsrmHeader"/>'
           '<w:footerReference w:type="default" r:id="rIdHotsrmFooter"/>'
           '<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1418" w:right="1418" w:bottom="1418" '
           'w:left="1418" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>')


def xml_escape(s: str) -> str:
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def base_reference(ctx: Context, tmp: Path) -> Path:
    """客户提供了 reference.docx 就用它，否则在 pandoc 默认样式上套用 hotsrm 的版式。"""
    if ctx.instance and (ctx.instance / 'reference.docx').exists():
        return ctx.instance / 'reference.docx'
    raw = subprocess.run(['pandoc', '--print-default-data-file', 'reference.docx'],
                         check=True, capture_output=True).stdout
    src = tmp / 'pandoc-reference.docx'
    src.write_bytes(raw)
    style = ctx.org.get('style') or {}
    defs = styles_xml(style.get('body_font', '宋体'), style.get('heading_font', '黑体'))
    out = tmp / 'hotsrm-reference.docx'
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == 'word/styles.xml':
                s = data.decode('utf-8')
                for sid, xml in defs.items():
                    s = re.sub(rf'<w:style [^>]*w:styleId="{sid}".*?</w:style>', '', s, flags=re.DOTALL)
                    s = s.replace('</w:styles>', xml + '</w:styles>')
                s = re.sub(r'<w:rFonts [^>]*/>', _font(style.get('body_font', '宋体')), s, count=1)
                s = s.replace('w:eastAsia="en-US"', 'w:eastAsia="zh-CN"')
                data = s.encode('utf-8')
            elif item.filename == 'word/document.xml':
                s = re.sub(r'<w:sectPr\s*/>|<w:sectPr>.*?</w:sectPr>', SECT_PR, data.decode('utf-8'), flags=re.DOTALL)
                data = s.encode('utf-8')
            elif item.filename == 'word/_rels/document.xml.rels':
                rel = ('<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/{0}" '
                       'Id="{1}" Target="{2}"/>')
                s = data.decode('utf-8').replace('</Relationships>', rel.format('header', 'rIdHotsrmHeader', 'header1.xml')
                                                 + rel.format('footer', 'rIdHotsrmFooter', 'footer1.xml') + '</Relationships>')
                data = s.encode('utf-8')
            elif item.filename == '[Content_Types].xml':
                ov = ('<Override PartName="/word/{0}1.xml" '
                      'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.{0}+xml"/>')
                s = data.decode('utf-8').replace('</Types>', ov.format('header') + ov.format('footer') + '</Types>')
                data = s.encode('utf-8')
            zout.writestr(item, data)
        zout.writestr('word/header1.xml', HEADER_XML)
        zout.writestr('word/footer1.xml', FOOTER_XML)
    return out


def reference_for(base: Path, tmp: Path, left: str, right: str) -> Path:
    """把页眉中的 {{header_left}}、{{header_right}} 换成本文件的内容。"""
    out = tmp / f'ref-{abs(hash((left, right)))}.docx'
    with zipfile.ZipFile(base) as zin, zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if re.match(r'word/header\d*\.xml$', item.filename):
                s = data.decode('utf-8').replace('{{header_left}}', xml_escape(left))
                data = s.replace('{{header_right}}', xml_escape(right)).encode('utf-8')
            zout.writestr(item, data)
    return out


def to_docx(md: Path, ref: Path, out: Path) -> None:
    subprocess.run(['pandoc', str(md), '-f', 'markdown-smart', '--columns=10', '-t', 'docx',
                    '--reference-doc', str(ref), '--lua-filter', str(HERE / 'filters.lua'), '-o', str(out)],
                   check=True)


# ---- 主流程 ----

def collect(ctx: Context, only: set[str]) -> list[tuple[str, Path, Path | None]]:
    """返回 [(代号, 模板路径, 覆盖目录)]：已编写且已组合的通用模板 + 客户自有文件。"""
    items = []
    for code, entry in ctx.index['documents'].items():
        if entry.get('status') != 'written':
            continue
        if entry['pack'] != 'core' and entry['pack'] not in ctx.packs:
            continue
        path = GOV / 'templates' / entry['pack'] / f'{code}.md'
        if not path.exists():
            raise BuildError(f'登记为已编写的 {code} 找不到模板 {path}')
        overrides = ctx.instance / 'overrides' / code if ctx.instance else None
        items.append((code, path, overrides))
    if ctx.instance and (ctx.instance / 'overrides').exists():
        known = {c for c, _, _ in items}
        for d in (ctx.instance / 'overrides').iterdir():
            if d.is_dir() and d.name not in known:
                raise BuildError(f'覆盖目录 {d} 没有对应的已组合模板')
    if ctx.instance and (ctx.instance / 'documents').exists():
        for path in sorted((ctx.instance / 'documents').glob('*.md')):
            items.append((path.stem, path, None))
    for code in ctx.notes:
        if code not in {c for c, _, _ in items}:
            raise BuildError(f'pending.yaml 中的 {code} 不是本次生成的文件')
    if only:
        items = [i for i in items if i[0] in only]
    return items


def summaries(ctx: Context) -> list[tuple[str, str, str]]:
    """返回 [(文件名主干, 页眉, Markdown)]：待确认事项清单与参数表。"""
    out = []
    if ctx.instance:
        items = list(dict.fromkeys(ctx.pending_items))
        rows = [[i + 1, code, where, what] for i, (code, where, what) in enumerate(items)]
        body = ('# 待确认事项\n\n以下事项需公司确认，确认后由实施顾问更新源文件并重新生成。\n\n'
                + md_table(['序号', '文件', '位置', '内容'], rows, [1, 2, 7, 6]))
        out.append(('待确认事项清单', '待确认事项清单', body))
    rows = []
    for key, d in ctx.defs.items():
        pack = ctx.param_pack[key]
        if pack != 'core' and pack not in ctx.packs:
            continue
        state = '待确认' if key in ctx.pending_keys else '已确认' if key in ctx.values else '默认'
        rows.append([d['label'], ctx.display(key), state,
                     '、'.join(d.get('used_in', [])), d.get('system', '')])
    body = ('# 参数表\n\n体系文件与 SRM 系统共用的参数。「默认」表示采用 hotsrm 的示例默认值。\n\n'
            + md_table(['参数', '取值', '状态', '使用位置', '系统中的位置'], rows, [4, 3, 2, 3, 7]))
    out.append(('参数表', '参数表', body))
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description='生成体系文件')
    ap.add_argument('--instance', type=Path, help='客户实例目录（客户私有仓库的 governance/）')
    ap.add_argument('--packs', default='', help='无客户实例时组合的扩展包，逗号分隔')
    ap.add_argument('--only', default='', help='只生成这些文件，逗号分隔的代号')
    ap.add_argument('--out', type=Path, help='输出目录，默认 <实例>/build 或 ./build')
    ap.add_argument('--md-only', action='store_true', help='只生成 Markdown，不转 Word')
    ap.add_argument('--check', action='store_true', help='只检查，不写文件')
    args = ap.parse_args(argv)

    try:
        instance = args.instance.resolve() if args.instance else None
        packs = [p for p in args.packs.split(',') if p]
        ctx = Context(instance, packs)
        only = {c for c in args.only.split(',') if c}
        rendered = []
        for code, path, overrides in collect(ctx, only):
            front, body = split_front(path.read_text(encoding='utf-8'), str(path))
            body = ctx.render(code, body, overrides)
            cover_md, header, stem = cover(ctx, code, front)
            rendered.append((stem, header, ctx.render(code, cover_md, None, is_body=False) + '\n' + body))
        rendered += summaries(ctx)
    except BuildError as e:
        print(f'错误：{e}', file=sys.stderr)
        return 1

    for w in sorted(set(ctx.warnings)):
        print(f'提示：{w}', file=sys.stderr)
    if args.check:
        print(f'检查通过：{len(rendered)} 个文件；待确认 {len(ctx.pending_items)} 处。')
        return 0

    out = (args.out or (instance / 'build' if instance else Path('build'))).resolve()
    out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as t:
        tmp = Path(t)
        base = None if args.md_only else base_reference(ctx, tmp)
        for stem, header, md in rendered:
            md_path = out / f'{stem}.md'
            md_path.write_text(md, encoding='utf-8')
            if base:
                ref = reference_for(base, tmp, ctx.org['company_name'], header)
                to_docx(md_path, ref, out / f'{stem}.docx')
            print(f'生成 {out / stem}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
