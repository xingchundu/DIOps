/**
 * 非 Oracle / 简化 Word：封面 + 按脚本分段表格。
 * [fix] 统一版式：A4 纵向封面 + 横向详细结果、固定列宽、封面分页、页眉页脚页码、
 *       中文结论映射、空结果不再输出只有表头的空表。
 */
const { Document, Packer, Paragraph, HeadingLevel, AlignmentType } = require('docx');
const {
  FONT, LANDSCAPE_W, statusLabel, p, fixedTable, pageBreak, headerFooter, sectionProperties,
} = require('./inspectDocxLayout');

async function buildGenericInspectDocxBuffer(payload) {
  const dbType = payload.dbType || 'DATABASE';
  const reportType = payload.reportType || '';
  const timeStr = payload.checkedAtLocal ||
    (payload.checkedAt ? String(payload.checkedAt).replace('T', ' ').slice(0, 19) : '');
  const sections = payload.scriptSections || [];
  const title = `${dbType} 数据库巡检报告（${reportType || '综合'}）`;

  const cover = [
    p('', { after: 600 }),
    p(title, { size: 48, bold: true, align: AlignmentType.CENTER, color: '1F3A5F', after: 160 }),
    p(payload.instanceName || '', { size: 28, align: AlignmentType.CENTER, after: 80 }),
    p(`巡检时间：${timeStr}`, { size: 22, align: AlignmentType.CENTER, color: '666666', after: 400 }),
    p(`综合得分：${payload.overallScore ?? '—'}`, { size: 36, bold: true, align: AlignmentType.CENTER, after: 120 }),
    p(`综合结论：${statusLabel(payload.overallStatus)}`, { size: 28, bold: true, align: AlignmentType.CENTER, after: 400 }),
    p(`数据库类型：${dbType}`, { size: 20, align: AlignmentType.CENTER }),
    p(`主机地址：${payload.host || ''}`, { size: 20, align: AlignmentType.CENTER }),
    p(`巡检人：${payload.inspectorName || 'AUTOMATION'}`, { size: 20, align: AlignmentType.CENTER }),
    pageBreak(),
  ];

  const detail = [new Paragraph({ text: '一、详细结果', heading: HeadingLevel.HEADING_1 })];
  if (!sections.length) {
    detail.push(p('（脚本无结果集输出）', { color: '888888' }));
  } else {
    let secSeq = 0;
    for (const sec of sections) {
      secSeq += 1;
      detail.push(new Paragraph({ text: `1.${secSeq} ${String(sec.title || '分段')}`, heading: HeadingLevel.HEADING_2 }));
      const tables = sec.tables || [];
      if (!tables.length) detail.push(p('（无返回记录）', { color: '888888' }));
      for (const tb of tables) {
        const cols = tb.columns || [];
        const rows = tb.rows || [];
        if (!cols.length || !rows.length) {
          detail.push(p('（无返回记录）', { color: '888888' }));
          continue;
        }
        const data = rows.slice(0, 200).map((r) => cols.map((c) => (r[c] != null ? String(r[c]) : '')));
        const t = fixedTable(cols, data, LANDSCAPE_W);
        if (t) detail.push(t);
        const notes = [];
        if (rows.length > 200) notes.push(`共 ${rows.length} 行，仅展示前 200 行`);
        if (cols.length > 16) notes.push(`共 ${cols.length} 列，仅展示前 16 列`);
        if (notes.length) detail.push(p(`${notes.join('；')}。`, { size: 15, color: '888888' }));
      }
    }
  }

  if (payload.scriptErrors && payload.scriptErrors.length) {
    detail.push(new Paragraph({ text: '二、执行异常', heading: HeadingLevel.HEADING_1 }));
    detail.push(p('以下语句执行失败，相关检查项结果不完整，建议补充授权后重新巡检：', { color: 'C0392B' }));
    for (const e of payload.scriptErrors.slice(0, 20)) {
      detail.push(p(`• ${e.error || e}`, { color: 'C0392B', size: 17 }));
    }
  }

  const hf = headerFooter(title, payload.instanceName || '');
  const doc = new Document({
    creator: 'DIOps', title,
    styles: { default: { document: { run: { font: FONT, size: 20 } } } },
    sections: [
      { properties: sectionProperties(false), ...hf, children: cover },
      { properties: sectionProperties(true), ...hf, children: detail },
    ],
  });
  return Packer.toBuffer(doc);
}

module.exports = { buildGenericInspectDocxBuffer };
