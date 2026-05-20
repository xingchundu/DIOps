/**
 * CheckV8 批量巡检：Excel 模板生成与上传解析（对齐原 CheckV8 批量流程，无邮件）。
 */
const ExcelJS = require('exceljs');

const COLS = [
  { key: 'instanceId', header: '实例ID(选填)', width: 14 },
  { key: 'host', header: '主机IP', width: 16 },
  { key: 'port', header: '端口', width: 8 },
  { key: 'serviceOrSid', header: '服务名或SID', width: 18 },
  { key: 'user', header: '数据库用户', width: 14 },
  { key: 'password', header: '数据库密码', width: 18 },
  { key: 'remark', header: '备注', width: 24 },
];

async function buildInspectExcelTemplateBuffer() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('巡检目标', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = COLS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  ws.addRow({
    instanceId: '',
    host: '192.168.1.10',
    port: 1521,
    serviceOrSid: 'ORCLPDB1',
    user: 'system',
    password: '请改为实际密码',
    remark: '示例行请删除后填写；填实例ID可走CMDB，可不填密码列',
  });
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7E6E6' } };
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

function cellStr(v) {
  if (v == null) return '';
  if (typeof v === 'object' && v.text != null) return String(v.text).trim();
  if (typeof v === 'object' && v.result != null) return String(v.result).trim();
  return String(v).trim();
}

function cellNum(v) {
  const s = cellStr(v);
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {Buffer} buffer
 * @returns {Promise<Array<{instanceId?:number,host?:string,port?:number,serviceOrSid?:string,user?:string,password?:string,remark?:string}>>}
 */
async function parseInspectExcelBuffer(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('工作簿无工作表');

  const targets = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const instanceId = cellNum(row.getCell(1).value);
    const host = cellStr(row.getCell(2).value);
    const port = cellNum(row.getCell(3).value);
    const serviceOrSid = cellStr(row.getCell(4).value);
    const user = cellStr(row.getCell(5).value);
    const passwordRaw = row.getCell(6).value;
    const password = passwordRaw != null ? String(passwordRaw) : '';
    const remark = cellStr(row.getCell(7).value);

    const empty = !host && !serviceOrSid && !user && !password && instanceId == null;
    if (empty) return;

    targets.push({
      instanceId: instanceId != null && !Number.isNaN(instanceId) ? instanceId : null,
      host: host || undefined,
      port: port != null ? port : undefined,
      serviceOrSid: serviceOrSid || undefined,
      user: user || undefined,
      password: password || undefined,
      remark: remark || undefined,
    });
  });

  return targets;
}

function validateTarget(t, rowIndex) {
  const line = `第${rowIndex}行`;
  if (t.instanceId != null && !Number.isNaN(Number(t.instanceId))) {
    return { ...t, instanceId: Number(t.instanceId) };
  }
  if (!t.host) throw new Error(`${line}: 未填实例ID时需填写主机IP`);
  if (t.port == null || !Number.isFinite(t.port)) throw new Error(`${line}: 需填写端口`);
  if (!t.serviceOrSid) throw new Error(`${line}: 需填写服务名或SID`);
  if (!t.user) throw new Error(`${line}: 需填写数据库用户`);
  if (!t.password) throw new Error(`${line}: 需填写数据库密码`);
  return t;
}

module.exports = {
  buildInspectExcelTemplateBuffer,
  parseInspectExcelBuffer,
  validateTarget,
};
