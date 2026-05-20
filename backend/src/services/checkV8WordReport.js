/**
 * 根据 CheckV8 JSON 结果生成 Word（.docx），对齐原脚本报告结构（精简版）。
 */
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  HeadingLevel,
  WidthType,
  AlignmentType,
} = require('docx');

function p(text, opts = {}) {
  return new Paragraph({
    children: [new TextRun({ text: String(text), font: 'SimSun', ...opts })],
    alignment: opts.align,
  });
}

function tableFromPairs(pairs) {
  const rows = pairs.map(([a, b]) =>
    new TableRow({
      children: [
        new TableCell({ children: [p(a, { bold: true })] }),
        new TableCell({ children: [p(b == null ? 'N/A' : String(b))] }),
      ],
    })
  );
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows,
  });
}

/**
 * @param {object} payload — runCheckV8Inspection 返回值
 * @param {string} targetTitle
 * @returns {Promise<Buffer>}
 */
async function buildCheckV8DocxBuffer(payload, targetTitle) {
  const basic = payload.basic_info || {};
  const dbst = payload.db_status || {};
  const issues = payload.issues || [];
  const tss = (payload.tablespaces || []).slice(0, 20);

  const basicPairs = [
    ['数据库名称', basic.db_name],
    ['版本', basic.db_version],
    ['实例名', basic.instance_name],
    ['主机名', basic.host_name],
    ['角色', basic.database_role],
    ['启动时间', basic.startup_time],
  ];

  const statusPairs = [
    ['实例状态', dbst.instance_status],
    ['归档模式', dbst.log_mode],
    ['活动会话', dbst.active_sessions],
    ['最大会话', dbst.max_sessions],
  ];

  const tsRows = [
    new TableRow({
      children: ['表空间', '使用率%', '状态'].map(
        (h) => new TableCell({ children: [p(h, { bold: true })] })
      ),
    }),
    ...tss.map(
      (x) =>
        new TableRow({
          children: [
            new TableCell({ children: [p(x.name || '')] }),
            new TableCell({ children: [p(String(x.used_pct ?? ''))] }),
            new TableCell({ children: [p(x.status || '')] }),
          ],
        })
    ),
  ];

  const children = [
    new Paragraph({
      text: 'Oracle 数据库深度巡检报告',
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
    }),
    p(`巡检目标: ${targetTitle}`, { italics: true }),
    p(`生成时间(UTC): ${payload.generatedAt || new Date().toISOString()}`, { italics: true }),
    p(`综合得分: ${payload.overallScore}  结论: ${payload.overallStatus}`, { bold: true }),
    new Paragraph({ text: '一、基础信息', heading: HeadingLevel.HEADING_1 }),
    tableFromPairs(basicPairs),
    new Paragraph({ text: '二、运行状态', heading: HeadingLevel.HEADING_1 }),
    tableFromPairs(statusPairs),
    new Paragraph({ text: '三、表空间 TOP', heading: HeadingLevel.HEADING_1 }),
    tss.length
      ? new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: tsRows })
      : p('（无表空间数据或权限不足）'),
    new Paragraph({ text: '四、问题摘要', heading: HeadingLevel.HEADING_1 }),
    ...(issues.length ? issues.map((x) => p(`• ${x}`)) : [p('无')]),
    new Paragraph({ text: '五、说明', heading: HeadingLevel.HEADING_1 }),
    p('本报告由 DIOps 平台根据 CheckV8 检查项自动生成；部分字典视图无权限时详见 JSON 中 skipped 字段。'),
  ];

  if (payload.skipped && payload.skipped.length) {
    children.push(new Paragraph({ text: '六、未执行项（权限等）', heading: HeadingLevel.HEADING_1 }));
    payload.skipped.slice(0, 30).forEach((s) => {
      children.push(p(`${s.section}: ${(s.error || '').slice(0, 500)}`));
    });
  }

  const doc = new Document({
    sections: [{ properties: {}, children }],
  });

  return await Packer.toBuffer(doc);
}

module.exports = { buildCheckV8DocxBuffer };
