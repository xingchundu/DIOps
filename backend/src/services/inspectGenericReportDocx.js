/**
 * 非 Oracle / 简化 Word：标题 + 按脚本分段表格。
 */
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  WidthType,
  AlignmentType,
  Table,
  TableRow,
  TableCell,
} = require('docx');

function p(text, opts = {}) {
  const runOpts = { text: String(text), font: 'SimSun' };
  if (opts.color) runOpts.color = String(opts.color).replace('#', '');
  if (opts.bold) runOpts.bold = true;
  if (opts.italics) runOpts.italics = true;
  return new Paragraph({ children: [new TextRun(runOpts)], alignment: opts.align });
}

function cellPara(text, opts = {}) {
  return new TableCell({ children: [p(text == null ? '' : String(text), opts)] });
}

function tableFromRows(header, rows) {
  const heads = header.map((h) => cellPara(h, { bold: true }));
  const dataRows = rows.map(
    (r) =>
      new TableRow({
        children: r.map((c) => cellPara(c)),
      })
  );
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({ children: heads }), ...dataRows],
  });
}

async function buildGenericInspectDocxBuffer(payload) {
  const dbType = payload.dbType || 'DATABASE';
  const reportType = payload.reportType || '';
  const timeStr =
    payload.checkedAtLocal ||
    (payload.checkedAt ? String(payload.checkedAt).replace('T', ' ').slice(0, 19) : '');
  const sections = payload.scriptSections || [];
  const children = [
    new Paragraph({
      text: `${dbType} 数据库巡检报告（${reportType}）`,
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
    }),
    new Paragraph({
      children: [new TextRun({ text: `巡检时间: ${timeStr}`, font: 'SimSun' })],
      alignment: AlignmentType.CENTER,
    }),
    p(`实例: ${payload.instanceName || ''}`, { italics: true }),
    p(`综合得分: ${payload.overallScore ?? '—'}  结论: ${payload.overallStatus ?? '—'}`, { bold: true }),
  ];

  if (!sections.length) {
    children.push(p('（脚本无结果集输出）'));
  } else {
    for (const sec of sections) {
      children.push(new Paragraph({ text: String(sec.title || '分段'), heading: HeadingLevel.HEADING_1 }));
      const tables = sec.tables || [];
      for (const tb of tables) {
        const cols = tb.columns || [];
        const rows = tb.rows || [];
        if (!cols.length) continue;
        const data = rows.map((r) => cols.map((c) => (r[c] != null ? String(r[c]) : '')));
        children.push(tableFromRows(cols, data));
      }
    }
  }

  if (payload.scriptErrors && payload.scriptErrors.length) {
    children.push(new Paragraph({ text: '执行异常', heading: HeadingLevel.HEADING_1 }));
    for (const e of payload.scriptErrors.slice(0, 20)) {
      children.push(p(`• ${e.error || e}`, { color: 'DC1414' }));
    }
  }

  const doc = new Document({
    sections: [{ properties: {}, children }],
  });
  return Packer.toBuffer(doc);
}

module.exports = { buildGenericInspectDocxBuffer };
