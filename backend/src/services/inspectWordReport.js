/**
 * 巡检 Word 报告生成（Node / docx，不依赖 Python）。
 *
 * 版式：
 *   封面（实例信息 + 评分 + 结论）
 *   第一部分「巡检总结」：总体结论 / 关键指标 / 分类概览 / 主要风险与整改建议 / 采集异常
 *   第二部分「详细结果」：按分类 → 检查项 → 结果表（命中发现项的行高亮；超过行数上限自动截断并注明）
 *   附录：脚本清单、评分口径、说明
 * 总结页纵向 A4，详细结果横向 A4（宽表更易读）。
 */
'use strict';

const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType,
  ShadingType, BorderStyle, PageOrientation, Header, Footer, PageNumber, LevelFormat, TableLayoutType, VerticalAlign,
} = require('docx');
const { CATEGORY_LABEL, CATEGORY_ORDER } = require('../utils/inspectScriptParser');
const { LEVEL_LABEL, LEVEL_RANK } = require('./inspectFindings');

const FONT = 'Microsoft YaHei';
const MAX_ROWS_IN_WORD = Math.max(20, Number(process.env.INSPECT_WORD_MAX_ROWS) || 200);
const CELL_MAX_CHARS = 300;
// [fix] 宽表原先按列数直接分摊，列多时最后一列会被算成负宽度 → Word 里列被挤没 / 版式错乱
const MAX_COLS_IN_TABLE = 16;

const COLORS = {
  head: '1F3A5F', headText: 'FFFFFF', zebra: 'F5F7FA', border: 'C9D1DB',
  CRITICAL: 'C0392B', WARNING: 'D68910', INFO: '2E86C1', NORMAL: '1E8449',
  rowCritical: 'FBE3E0', rowWarning: 'FDF1DC', rowInfo: 'E3F0FA',
};
const STATUS_LABEL = { NORMAL: '正常', WARNING: '预警', CRITICAL: '严重' };

// A4：纵向内容宽 = 11906 - 2*1134 ；横向内容宽 = 16838 - 2*1134
const PORTRAIT_W = 9638;
const LANDSCAPE_W = 14570;

const border = { style: BorderStyle.SINGLE, size: 4, color: COLORS.border };
const borders = { top: border, bottom: border, left: border, right: border };

function run(text, o = {}) {
  return new TextRun({ text: String(text ?? ''), font: FONT, size: o.size || 20, bold: o.bold, color: o.color, italics: o.italics });
}
function para(text, o = {}) {
  return new Paragraph({
    children: Array.isArray(text) ? text : [run(text, o)],
    alignment: o.align, spacing: { before: o.before ?? 0, after: o.after ?? 80, line: o.line },
    keepNext: o.keepNext, indent: o.indent,
  });
}
function h(text, level) {
  return new Paragraph({ heading: level, children: [new TextRun({ text, font: FONT })], keepNext: true });
}
function bullet(text, o = {}) {
  return new Paragraph({ numbering: { reference: 'bul', level: 0 }, children: [run(text, o)], spacing: { after: 40 } });
}

function clip(v) {
  if (v == null) return '';
  const s = String(v).replace(/\r?\n/g, ' ');
  return s.length > CELL_MAX_CHARS ? `${s.slice(0, CELL_MAX_CHARS)}…` : s;
}

function cell(text, width, o = {}) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA }, borders,
    shading: o.fill ? { fill: o.fill, type: ShadingType.CLEAR, color: 'auto' } : undefined,
    margins: { top: 50, bottom: 50, left: 90, right: 90 }, verticalAlign: VerticalAlign.CENTER,
    children: [new Paragraph({ alignment: o.align, children: [run(text, { size: o.size || 18, bold: o.bold, color: o.color })] })],
  });
}

/** 通用表格：columns 为 [{title, w(权重), align}]，rows 为二维字符串；rowFill(i) 返回行底色 */
function table(columns, rows, totalW, rowFill, opt = {}) {
  // 超过上限的列统一截断，并在调用方注明；避免 Word 表格宽度溢出页面
  const cols = columns.slice(0, MAX_COLS_IN_TABLE);
  const displayRows = rows.map((r) => r.slice(0, MAX_COLS_IN_TABLE));
  const sum = cols.reduce((a, c) => a + Math.max(0.001, Number(c.w) || 1), 0);
  let widths = cols.map((c) => Math.max(400, Math.floor((totalW * Math.max(0.001, Number(c.w) || 1)) / sum)));
  let total = widths.reduce((a, b) => a + b, 0);
  if (total > totalW) {
    // 列很多时按比例整体收缩，不要用「最后一列补差额」把宽度补成负数
    const k = totalW / total;
    widths = widths.map((w) => Math.max(300, Math.floor(w * k)));
    total = widths.reduce((a, b) => a + b, 0);
  }
  const diff = totalW - total;
  if (diff !== 0 && widths.length) {
    const widest = widths.indexOf(Math.max(...widths));
    widths[widest] = Math.max(300, widths[widest] + diff);
  }
  const head = new TableRow({
    tableHeader: true, cantSplit: true,
    children: cols.map((c, i) => cell(c.title, widths[i], { fill: COLORS.head, color: COLORS.headText, bold: true, size: opt.size })),
  });
  const body = displayRows.map((r, ri) => new TableRow({
    cantSplit: true,
    children: cols.map((c, i) => {
      const v = r[i];
      const fill = (rowFill && rowFill(ri, i, v)) || (ri % 2 ? COLORS.zebra : undefined);
      const colr = typeof v === 'object' && v !== null ? v.color : undefined;
      const txt = typeof v === 'object' && v !== null ? v.text : v;
      return cell(clip(txt), widths[i], { fill, align: c.align, size: opt.size, color: colr, bold: typeof v === 'object' && v?.bold });
    }),
  }));
  return new Table({ width: { size: totalW, type: WidthType.DXA }, columnWidths: widths, layout: TableLayoutType.FIXED, rows: [head, ...body] });
}

function kvTable(pairs, totalW) {
  const w1 = Math.floor(totalW * 0.22);
  const w2 = Math.floor(totalW * 0.28);
  const rows = [];
  for (let i = 0; i < pairs.length; i += 2) {
    const a = pairs[i];
    const b = pairs[i + 1] || ['', ''];
    rows.push(new TableRow({
      children: [
        cell(a[0], w1, { fill: 'EAEFF5', bold: true }), cell(a[1], w2),
        cell(b[0], w1, { fill: 'EAEFF5', bold: true }), cell(b[1], totalW - w1 * 2 - w2),
      ],
    }));
  }
  return new Table({ width: { size: totalW, type: WidthType.DXA }, columnWidths: [w1, w2, w1, totalW - w1 * 2 - w2], layout: TableLayoutType.FIXED, rows });
}

function statusColor(s) { return COLORS[s] || COLORS.NORMAL; }
function levelFill(l) { return l === 'CRITICAL' ? COLORS.rowCritical : l === 'WARNING' ? COLORS.rowWarning : l === 'INFO' ? COLORS.rowInfo : undefined; }

function fmtTime(s) {
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return String(s);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function categoryStats(payload) {
  const map = new Map();
  const get = (c) => { if (!map.has(c)) map.set(c, { category: c, sections: 0, failed: 0, critical: 0, warning: 0, info: 0 }); return map.get(c); };
  for (const s of payload.sections || []) {
    const g = get(s.category || 'OTHER');
    g.sections += 1;
    if ((s.errors || []).length) g.failed += 1;
  }
  for (const f of payload.findings || []) {
    const g = get(f.category || 'OTHER');
    if (f.level === 'CRITICAL') g.critical += 1; else if (f.level === 'WARNING') g.warning += 1; else g.info += 1;
  }
  const ordered = CATEGORY_ORDER.filter((c) => map.has(c));
  // 未知分类也要出现在概览里，否则「分类概览」会凭空少掉若干检查项
  const rest = [...map.keys()].filter((c) => !CATEGORY_ORDER.includes(c)).sort();
  return [...ordered, ...rest].map((c) => map.get(c));
}

/**
 * @param {object} payload 巡检结果：
 *   { title?, dbType, instanceName, host, taskName, checkedAtLocal|checkedAt, inspectorName, overallScore, overallStatus,
 *     conclusion, counts:{critical,warning,info,collectErrors}, sections, findings, collectErrors, scripts:[{name,dbType,category,version}],
 *     categoryFilter? }
 * @returns {Promise<Buffer>}
 */
async function buildInspectWordBuffer(payload) {
  const p = payload || {};
  const sections = p.sections || [];
  const findings = [...(p.findings || [])].sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]);
  const collectErrors = p.collectErrors || [];
  const counts = p.counts || {
    critical: findings.filter((f) => f.level === 'CRITICAL').length,
    warning: findings.filter((f) => f.level === 'WARNING').length,
    info: findings.filter((f) => f.level === 'INFO').length,
    collectErrors: collectErrors.length,
  };
  const status = p.overallStatus || 'NORMAL';
  const scopeLabel = p.categoryFilter ? `（${CATEGORY_LABEL[p.categoryFilter] || p.categoryFilter}）` : '';
  const title = `${p.dbType || '数据库'} 巡检报告${scopeLabel}`;
  const okSections = sections.filter((s) => !(s.errors || []).length).length;
  const tableCount = sections.reduce((a, s) => a + (s.tables || []).length, 0);
  const rowCount = sections.reduce((a, s) => a + (s.tables || []).reduce((b, t) => b + (t.rows || []).length, 0), 0);

  // ───────── 封面 + 第一部分：总结（纵向）─────────
  const cover = [
    para('', { after: 600 }),
    para(title, { size: 52, bold: true, align: AlignmentType.CENTER, color: COLORS.head, after: 160 }),
    para(p.instanceName || '', { size: 30, align: AlignmentType.CENTER, after: 80 }),
    para(`巡检时间：${p.checkedAtLocal || fmtTime(p.checkedAt)}`, { size: 22, align: AlignmentType.CENTER, color: '666666', after: 400 }),
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { after: 120 },
      children: [run(`${p.overallScore ?? '—'}`, { size: 96, bold: true, color: statusColor(status) }), run(' 分', { size: 28, color: '666666' })],
    }),
    para(`综合结论：${STATUS_LABEL[status] || status}`, { size: 28, bold: true, align: AlignmentType.CENTER, color: statusColor(status), after: 400 }),
    kvTable([
      ['数据库类型', p.dbType || ''], ['实例', p.instanceName || ''],
      ['地址', p.host || ''], ['巡检任务', p.taskName || ''],
      ['巡检人', p.inspectorName || 'AUTOMATION'], ['检查项数', `${sections.length}（成功 ${okSections}）`],
    ], PORTRAIT_W),
    new Paragraph({ pageBreakBefore: true, children: [] }),
  ];

  const summary = [h('一、巡检总结', HeadingLevel.HEADING_1)];
  summary.push(h('1.1 总体结论', HeadingLevel.HEADING_2));
  summary.push(para(p.conclusion || '本次巡检已完成。', { size: 21, after: 120 }));
  if (p.unreliable) summary.push(para('⚠ 超过半数检查项执行失败，本报告不能作为“健康”依据，请先修复采集权限后重新巡检。', { color: COLORS.CRITICAL, bold: true }));

  summary.push(h('1.2 关键指标', HeadingLevel.HEADING_2));
  summary.push(table(
    [{ title: '指标', w: 3 }, { title: '数值', w: 2, align: AlignmentType.CENTER }, { title: '指标', w: 3 }, { title: '数值', w: 2, align: AlignmentType.CENTER }],
    [
      ['综合评分', { text: String(p.overallScore ?? '—'), color: statusColor(status), bold: true }, '检查项总数', String(sections.length)],
      ['严重问题', { text: String(counts.critical), color: counts.critical ? COLORS.CRITICAL : undefined, bold: true }, '结果表 / 记录数', `${tableCount} / ${rowCount}`],
      ['警告', { text: String(counts.warning), color: counts.warning ? COLORS.WARNING : undefined, bold: true }, '执行失败语句', String(counts.collectErrors)],
      ['提示', String(counts.info), '涉及脚本数', String((p.scripts || []).length || '—')],
    ], PORTRAIT_W));

  summary.push(h('1.3 分类概览', HeadingLevel.HEADING_2));
  const stats = categoryStats(p);
  summary.push(table(
    [{ title: '分类', w: 3 }, { title: '检查项', w: 1.5, align: AlignmentType.CENTER }, { title: '严重', w: 1.2, align: AlignmentType.CENTER },
      { title: '警告', w: 1.2, align: AlignmentType.CENTER }, { title: '提示', w: 1.2, align: AlignmentType.CENTER }, { title: '失败项', w: 1.2, align: AlignmentType.CENTER }, { title: '结论', w: 1.5, align: AlignmentType.CENTER }],
    stats.map((g) => {
      const st = g.critical ? 'CRITICAL' : g.warning || g.failed ? 'WARNING' : 'NORMAL';
      return [CATEGORY_LABEL[g.category] || g.category, String(g.sections), String(g.critical), String(g.warning), String(g.info), String(g.failed),
        { text: STATUS_LABEL[st], color: statusColor(st), bold: true }];
    }), PORTRAIT_W));

  summary.push(h('1.4 主要风险与整改建议', HeadingLevel.HEADING_2));
  if (!findings.length) {
    summary.push(para('本次巡检未发现需要处理的问题。', { color: COLORS.NORMAL, bold: true }));
  } else {
    const top = findings.slice(0, 60);
    summary.push(table(
      [{ title: '#', w: 0.6, align: AlignmentType.CENTER }, { title: '级别', w: 1, align: AlignmentType.CENTER }, { title: '分类', w: 1.2 },
        { title: '检查项', w: 2.2 }, { title: '问题 / 证据', w: 3.4 }, { title: '整改建议', w: 3.4 }],
      top.map((f, i) => [
        String(i + 1), { text: LEVEL_LABEL[f.level], color: COLORS[f.level], bold: true }, CATEGORY_LABEL[f.category] || f.category || '',
        f.section || '',
        `${f.title}${f.count > 1 ? `（${f.count} 处）` : ''}${f.samples && f.samples.length ? `：${f.samples[0]}` : f.detail ? `：${f.detail}` : ''}`,
        f.advice || '',
      ]), PORTRAIT_W, null, { size: 17 }));
    if (findings.length > top.length) summary.push(para(`其余 ${findings.length - top.length} 项见 Excel 汇总 / 详细结果。`, { italics: true, color: '666666', before: 60 }));
  }

  summary.push(h('1.5 采集异常', HeadingLevel.HEADING_2));
  if (!collectErrors.length) {
    summary.push(para('所有检查语句均执行成功。'));
  } else {
    summary.push(para('以下语句执行失败（多为账号权限不足、视图不存在或版本差异），对应检查项结果不完整，需补充授权后重新巡检：', { color: COLORS.WARNING }));
    summary.push(table(
      [{ title: '检查项', w: 2.4 }, { title: '错误信息', w: 4 }, { title: '语句片段', w: 4 }],
      collectErrors.slice(0, 30).map((e) => [e.section || '', e.error || '', (e.sql || '').replace(/\s+/g, ' ').slice(0, 120)]),
      PORTRAIT_W, null, { size: 16 }));
    if (collectErrors.length > 30) summary.push(para(`另有 ${collectErrors.length - 30} 条未列出。`, { italics: true, color: '666666' }));
  }

  // ───────── 第二部分：详细结果（横向）─────────
  const detail = [h('二、详细结果', HeadingLevel.HEADING_1)];
  if (!sections.length) detail.push(para('脚本没有产生任何检查项结果。'));

  const hitIndex = new Map(); // `${secNo}:${t}:${r}` → level
  for (const f of findings) {
    for (const hit of f.hits || []) {
      const k = `${f.sectionNo}|${f.section}:${hit.t}:${hit.r}`;
      const prev = hitIndex.get(k);
      if (!prev || LEVEL_RANK[hit.level] > LEVEL_RANK[prev]) hitIndex.set(k, hit.level);
    }
  }

  // [fix] 原编号用 CATEGORY_ORDER.indexOf(cat)+1，分类版只剩 1 个分类时直接出现「2.2」而无 2.1；
  //       且二级 2.N 与三级连续 secSeq 是两套互不相干的编号。改为按实际出现的分类连续编号，三级共用同一层级。
  let catSeq = 0;
  const knownCats = CATEGORY_ORDER.filter((c) => sections.some((s) => (s.category || 'OTHER') === c));
  const extraCats = [...new Set(sections.map((s) => s.category || 'OTHER'))]
    .filter((c) => !CATEGORY_ORDER.includes(c)).sort();
  for (const cat of [...knownCats, ...extraCats]) {
    const list = sections.filter((s) => (s.category || 'OTHER') === cat);
    if (!list.length) continue;
    catSeq += 1;
    detail.push(h(`2.${catSeq} ${CATEGORY_LABEL[cat] || cat}`, HeadingLevel.HEADING_2));
    let itemSeq = 0;
    for (const sec of list) {
      itemSeq += 1;
      const secFindings = findings.filter((f) => f.sectionNo === sec.no && f.section === sec.title);
      const worst = secFindings[0]?.level;
      detail.push(new Paragraph({
        heading: HeadingLevel.HEADING_3, keepNext: true,
        children: [new TextRun({ text: `2.${catSeq}.${itemSeq} ${sec.title}`, font: FONT }),
          ...(worst ? [new TextRun({ text: `   [${LEVEL_LABEL[worst]} ${secFindings.length} 项]`, font: FONT, color: COLORS[worst], size: 20 })] : [])],
      }));
      for (const f of secFindings.slice(0, 5)) {
        detail.push(para(`• ${LEVEL_LABEL[f.level]}：${f.title}${f.samples && f.samples[0] ? `（${f.samples[0]}）` : ''}　建议：${f.advice}`, { size: 17, color: COLORS[f.level], after: 40 }));
      }
      for (const e of sec.errors || []) detail.push(para(`执行失败：${e.error}`, { size: 17, color: COLORS.CRITICAL }));
      if (!(sec.tables || []).length && !(sec.errors || []).length) detail.push(para('（无返回记录）', { size: 18, color: '888888' }));

      (sec.tables || []).forEach((tb, ti) => {
        const allCols = tb.columns || [];
        const allRows = tb.rows || [];
        const rows = allRows.slice(0, MAX_ROWS_IN_WORD);
        // [fix] 空结果原来仍生成「只有表头」的空表，报告里满屏空表格显得不规则
        if (!allCols.length || !allRows.length) {
          detail.push(para('（无返回记录）', { size: 18, color: '888888', before: 40, after: 120 }));
          return;
        }
        const cols = allCols.slice(0, MAX_COLS_IN_TABLE);
        // 列宽权重：按列名与内容最大长度
        const weights = cols.map((c) => {
          let mx = String(c).length;
          for (const r of rows.slice(0, 50)) mx = Math.max(mx, Math.min(40, String(r[c] ?? '').length));
          return Math.max(4, mx);
        });
        detail.push(table(
          cols.map((c, i) => ({ title: String(c), w: weights[i] })),
          rows.map((r) => cols.map((c) => r[c])),
          LANDSCAPE_W,
          (ri) => levelFill(hitIndex.get(`${sec.no}|${sec.title}:${ti}:${ri}`)),
          { size: cols.length > 10 ? 14 : 16 }));
        const total = tb.truncated ? `${tb.rowCount}` : String(allRows.length);
        const notes = [];
        if (allRows.length > rows.length || tb.truncated) notes.push(`共 ${total} 行，仅展示前 ${rows.length} 行`);
        else notes.push(`共 ${allRows.length} 行`);
        if (allCols.length > cols.length) notes.push(`共 ${allCols.length} 列，仅展示前 ${cols.length} 列`);
        detail.push(para(`${notes.join('；')}。`, { size: 15, color: '888888', before: 40, after: 120 }));
      });
    }
  }

  // ───────── 附录 ─────────
  const appendix = [h('附录', HeadingLevel.HEADING_1), h('A. 巡检脚本', HeadingLevel.HEADING_2)];
  if ((p.scripts || []).length) {
    appendix.push(table(
      [{ title: '脚本名称', w: 4 }, { title: 'DB 类型', w: 1.5 }, { title: '分类', w: 1.5 }, { title: '版本', w: 1 }],
      p.scripts.map((s) => [s.name || '', s.dbType || '', s.category || '', s.version || '']), LANDSCAPE_W));
  } else {
    appendix.push(para(p.scriptNote || '使用平台内置 master 巡检模板。'));
  }
  appendix.push(h('B. 评分口径', HeadingLevel.HEADING_2));
  ['综合评分从 100 分起扣：严重问题每项 -10（最多 -60），警告每项 -3（最多 -30），提示每项 -1（最多 -5），语句执行失败每条 -2（最多 -10）。',
    '结论：存在严重问题或评分 < 70 为“严重”；存在警告 / 执行失败或评分 < 85 为“预警”；否则“正常”。',
    '发现项来自：脚本中的 “-- @rule” 阈值指令，以及通用规则（使用率 ≥85% / ≥95%、状态列异常值、风险等级列、结果含错误信息、列出异常对象的检查项有返回行）。',
    '发现项是巡检线索，不等同于故障结论，请结合业务与变更情况评估。'].forEach((t) => appendix.push(bullet(t, { size: 19 })));

  const pageMargin = { top: 1134, bottom: 1134, left: 1134, right: 1134 };
  const headerFooter = {
    headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [run(`${title} · ${p.instanceName || ''}`, { size: 16, color: '888888' })] })] }) },
    footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [
      new TextRun({ children: ['第 ', PageNumber.CURRENT, ' 页 / 共 ', PageNumber.TOTAL_PAGES, ' 页'], font: FONT, size: 16, color: '888888' })] })] }) },
  };

  const doc = new Document({
    creator: 'DIOps', title,
    styles: {
      default: { document: { run: { font: FONT, size: 20 } } },
      paragraphStyles: [
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: FONT, size: 32, bold: true, color: COLORS.head }, paragraph: { spacing: { before: 240, after: 160 }, keepNext: true, outlineLevel: 0 } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: FONT, size: 26, bold: true, color: '2C5282' }, paragraph: { spacing: { before: 200, after: 100 }, keepNext: true, outlineLevel: 1 } },
        { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: FONT, size: 22, bold: true }, paragraph: { spacing: { before: 160, after: 80 }, keepNext: true, outlineLevel: 2 } },
      ],
    },
    numbering: { config: [{ reference: 'bul', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 270 } } } }] }] },
    sections: [
      { properties: { page: { size: { width: 11906, height: 16838 }, margin: pageMargin } }, ...headerFooter, children: [...cover, ...summary] },
      { properties: { page: { size: { width: 11906, height: 16838, orientation: PageOrientation.LANDSCAPE }, margin: pageMargin } }, ...headerFooter, children: [...detail, ...appendix] },
    ],
  });
  return Packer.toBuffer(doc);
}

module.exports = { buildInspectWordBuffer };
