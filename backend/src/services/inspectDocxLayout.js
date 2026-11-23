/**
 * 巡检 Word 报告统一版式组件。
 *
 * 背景：工程里同时存在 4 套 Word 生成器，其中「简化版 / OracleDBDI 版」原来是
 * `sections: [{ properties: {}, children }]` —— 页面属性全空（默认 Letter 纵向）、
 * 表格只有 100% 宽没有列宽和 FIXED 布局、封面和正文不分页、没有页眉页脚页码，
 * 是「报告不规则」最直观的来源。这里抽出与 inspectWordReport.js 一致的版式常量，
 * 供两套简化生成器复用。
 */
'use strict';

const {
  Paragraph, TextRun, Table, TableRow, TableCell, WidthType, TableLayoutType,
  Header, Footer, PageNumber, AlignmentType, BorderStyle, ShadingType, VerticalAlign, PageOrientation,
} = require('docx');

const FONT = 'Microsoft YaHei';
const LANDSCAPE_W = 14570;   // A4 横向内容宽（16838 - 2*1134）
const PORTRAIT_W = 9638;     // A4 纵向内容宽（11906 - 2*1134）
const PAGE_MARGIN = { top: 1134, bottom: 1134, left: 1134, right: 1134 };
const MAX_COLS = 16;
const CELL_MAX_CHARS = 300;

const COLORS = { head: '1F3A5F', headText: 'FFFFFF', zebra: 'F5F7FA', border: 'C9D1DB' };
const STATUS_LABEL = {
  NORMAL: '正常', WARNING: '预警', CRITICAL: '严重', INFO: '提示',
  GOOD: '良好', HEALTHY: '健康', UNKNOWN: '未知', '优良': '优良',
};

const border = { style: BorderStyle.SINGLE, size: 4, color: COLORS.border };
const borders = { top: border, bottom: border, left: border, right: border };

function statusLabel(s) {
  if (s == null || s === '') return '—';
  return STATUS_LABEL[String(s).toUpperCase()] || STATUS_LABEL[s] || String(s);
}

function clip(v) {
  if (v == null) return '';
  const s = String(v).replace(/\r?\n/g, ' ');
  return s.length > CELL_MAX_CHARS ? `${s.slice(0, CELL_MAX_CHARS)}…` : s;
}

function p(text, o = {}) {
  return new Paragraph({
    children: [new TextRun({ text: String(text ?? ''), font: FONT, size: o.size || 20, bold: o.bold, color: o.color, italics: o.italics })],
    alignment: o.align, spacing: { before: o.before ?? 0, after: o.after ?? 80 }, keepNext: o.keepNext,
  });
}

function cell(text, width, o = {}) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA }, borders,
    shading: o.fill ? { fill: o.fill, type: ShadingType.CLEAR, color: 'auto' } : undefined,
    margins: { top: 50, bottom: 50, left: 90, right: 90 }, verticalAlign: VerticalAlign.CENTER,
    children: [new Paragraph({ children: [new TextRun({ text: clip(text), font: FONT, size: o.size || 18, bold: o.bold, color: o.color })] })],
  });
}

/** 固定布局表格：列宽按内容长度加权，永不为负；空表返回 null（由调用方输出「无返回记录」） */
function fixedTable(columns, rows, totalW = LANDSCAPE_W, styleFn = null) {
  const cols = columns.slice(0, MAX_COLS);
  if (!cols.length || !rows.length) return null;
  const displayRows = rows.slice(0, 200).map((r) => r.slice(0, MAX_COLS));
  const weights = cols.map((c, i) => {
    let mx = String(c).length;
    for (const r of displayRows.slice(0, 50)) mx = Math.max(mx, Math.min(40, String(r[i] ?? '').length));
    return Math.max(4, mx);
  });
  const sum = weights.reduce((a, b) => a + b, 0);
  let widths = weights.map((w) => Math.max(400, Math.floor((totalW * w) / sum)));
  let total = widths.reduce((a, b) => a + b, 0);
  if (total > totalW) {
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
    children: cols.map((c, i) => cell(c, widths[i], { fill: COLORS.head, color: COLORS.headText, bold: true })),
  });
  const body = displayRows.map((r, ri) => new TableRow({
    cantSplit: true,
    children: cols.map((c, i) => {
      const style = styleFn ? (styleFn(ri, i, r[i]) || {}) : {};
      const colr = style.color ? String(style.color).replace('#', '') : undefined;
      return cell(r[i], widths[i], { fill: ri % 2 ? COLORS.zebra : undefined, color: colr, bold: !!style.bold });
    }),
  }));
  return new Table({ width: { size: totalW, type: WidthType.DXA }, columnWidths: widths, layout: TableLayoutType.FIXED, rows: [head, ...body] });
}

/** 封面后强制分页，避免标题/时间/得分与正文表格挤在同一页 */
function pageBreak() {
  return new Paragraph({ pageBreakBefore: true, children: [] });
}

function headerFooter(title, subtitle = '') {
  return {
    headers: { default: new Header({ children: [new Paragraph({
      alignment: AlignmentType.RIGHT,
      children: [new TextRun({ text: `${title} · ${subtitle}`, font: FONT, size: 16, color: '888888' })],
    })] }) },
    footers: { default: new Footer({ children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ children: ['第 ', PageNumber.CURRENT, ' 页 / 共 ', PageNumber.TOTAL_PAGES, ' 页'], font: FONT, size: 16, color: '888888' })],
    })] }) },
  };
}

/** A4 横向分节属性（详细结果用）；纵向把 orientation 去掉即可 */
function sectionProperties(landscape = true) {
  const size = landscape
    ? { width: 11906, height: 16838, orientation: PageOrientation.LANDSCAPE }
    : { width: 11906, height: 16838 };
  return { page: { size, margin: PAGE_MARGIN } };
}

module.exports = {
  FONT, LANDSCAPE_W, PORTRAIT_W, PAGE_MARGIN, MAX_COLS, COLORS,
  statusLabel, clip, p, cell, fixedTable, pageBreak, headerFooter, sectionProperties,
};
