/**
 * 资产管理：实例批量导入 Excel（多 Sheet：Oracle / MySQL / PostgreSQL / 达梦 / GoldenDB / 其他）
 */
const ExcelJS = require('exceljs');

const SHEETS = [
  { name: 'Oracle', dbType: 'ORACLE', defaultPort: 1521, defaultCharset: 'AL32UTF8' },
  { name: 'MySQL', dbType: 'MYSQL', defaultPort: 3306, defaultCharset: 'utf8mb4' },
  { name: 'PostgreSQL', dbType: 'POSTGRESQL', defaultPort: 5432, defaultCharset: 'UTF8' },
  { name: 'Dameng', dbType: 'DAMENG', defaultPort: 5236, defaultCharset: 'UTF-8' },
  { name: 'GoldenDB', dbType: 'GOLDENDB', defaultPort: 3306, defaultCharset: 'utf8mb4' },
  { name: '其他', dbType: null, defaultPort: 1521, defaultCharset: '' },
];

const HEADERS_OTHER = [
  '数据库类型',
  '实例名称',
  '主机IP',
  '端口',
  'SID',
  'Service名',
  'DB用户',
  'DB密码',
  '版本',
  '字符集',
  '环境',
  '业务线',
  '标签',
  '角色',
];

const HEADERS_STD = HEADERS_OTHER.slice(1);

function styleHeaderRow(row) {
  row.font = { bold: true };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7E6E6' } };
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

const COL_WIDTHS_STD = [22, 16, 8, 12, 16, 12, 14, 14, 14, 12, 10, 14, 16];
const COL_WIDTHS_OTHER = [14, ...COL_WIDTHS_STD];

async function buildCmdbInstanceImportTemplate() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'DIOps';

  for (const spec of SHEETS) {
    const ws = wb.addWorksheet(spec.name, { views: [{ state: 'frozen', ySplit: 1 }] });
    const headers = spec.dbType ? HEADERS_STD : HEADERS_OTHER;
    const widths = spec.dbType ? COL_WIDTHS_STD : COL_WIDTHS_OTHER;
    headers.forEach((_, idx) => {
      ws.getColumn(idx + 1).width = widths[idx] || 14;
    });

    const ex = spec.dbType
      ? {
          实例名称: `${spec.name}-示例`,
          主机IP: '192.168.1.10',
          端口: spec.defaultPort,
          SID:
            spec.dbType === 'ORACLE'
              ? 'ORCL'
              : spec.dbType === 'MYSQL'
                ? 'mysql'
                : spec.dbType === 'POSTGRESQL'
                  ? 'postgres'
                  : spec.dbType === 'DAMENG'
                    ? 'DMSERVER'
                    : spec.dbType === 'GOLDENDB'
                      ? ''
                      : '',
          Service名:
            spec.dbType === 'ORACLE'
              ? 'ORCLPDB1'
              : spec.dbType === 'DAMENG'
                ? ''
                : '',
          DB用户:
            spec.dbType === 'ORACLE'
              ? 'system'
              : spec.dbType === 'DAMENG'
                ? 'SYSDBA'
                : spec.dbType === 'GOLDENDB'
                  ? 'root'
                  : 'root',
          DB密码: '请改为实际密码',
          版本: '',
          字符集: spec.defaultCharset,
          环境: 'PROD',
          业务线: '',
          标签: '',
          角色: 'PRIMARY',
        }
      : {
          数据库类型: 'SQLSERVER',
          实例名称: '其他库-示例',
          主机IP: '192.168.1.20',
          端口: 1433,
          SID: '',
          Service名: '',
          DB用户: 'sa',
          DB密码: '请改为实际密码',
          版本: '',
          字符集: '',
          环境: 'PROD',
          业务线: '',
          标签: '',
          角色: 'PRIMARY',
        };

    const headerRow = ws.getRow(1);
    headers.forEach((h, idx) => {
      headerRow.getCell(idx + 1).value = h;
    });
    styleHeaderRow(headerRow);

    const dataRow = ws.getRow(2);
    headers.forEach((h, idx) => {
      dataRow.getCell(idx + 1).value = ex[h] != null && ex[h] !== '' ? ex[h] : '';
    });

    ws.getRow(3).getCell(1).value =
      '说明：删除第2行示例后填写数据行。密码列填明文，导入后按平台既有规则写入库。';
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

function sheetDbType(sheetName) {
  const n = String(sheetName || '').trim();
  if (n === 'Oracle') return 'ORACLE';
  if (n === 'MySQL') return 'MYSQL';
  if (n === 'PostgreSQL' || n === 'PG' || n.toLowerCase() === 'postgresql') return 'POSTGRESQL';
  if (n === 'Dameng' || n === '达梦') return 'DAMENG';
  if (n === 'GoldenDB' || n.toUpperCase() === 'GOLDENDB') return 'GOLDENDB';
  if (n === '其他') return 'OTHER';
  return null;
}

function defaultPortForType(dbType) {
  if (dbType === 'MYSQL' || dbType === 'GOLDENDB') return 3306;
  if (dbType === 'POSTGRESQL') return 5432;
  if (dbType === 'DAMENG') return 5236;
  return 1521;
}

function defaultCharsetForType(dbType) {
  if (dbType === 'MYSQL' || dbType === 'GOLDENDB') return 'utf8mb4';
  if (dbType === 'POSTGRESQL') return 'UTF8';
  if (dbType === 'ORACLE') return 'AL32UTF8';
  if (dbType === 'DAMENG') return 'UTF-8';
  return '';
}

/**
 * @returns {Array<object>} 带 _sheet _line 用于错误定位
 */
async function parseCmdbInstanceImportBuffer(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const out = [];

  for (const ws of wb.worksheets) {
    const st = sheetDbType(ws.name);
    if (!st) continue;

    const isOther = st === 'OTHER';
    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;

      let instanceName;
      let hostIp;
      let port;
      let sid;
      let serviceName;
      let dbUser;
      let dbPassword;
      let dbVersion;
      let charset;
      let environment;
      let bizLine;
      let tags;
      let role;
      let dbType = st === 'OTHER' ? null : st;

      if (isOther) {
        const dt = cellStr(row.getCell(1).value).toUpperCase();
        instanceName = cellStr(row.getCell(2).value);
        hostIp = cellStr(row.getCell(3).value);
        port = cellNum(row.getCell(4).value);
        sid = cellStr(row.getCell(5).value) || null;
        serviceName = cellStr(row.getCell(6).value) || null;
        dbUser = cellStr(row.getCell(7).value) || null;
        const pr = row.getCell(8).value;
        dbPassword = pr != null ? String(pr) : '';
        dbVersion = cellStr(row.getCell(9).value) || null;
        charset = cellStr(row.getCell(10).value) || null;
        environment = cellStr(row.getCell(11).value) || 'PROD';
        bizLine = cellStr(row.getCell(12).value) || null;
        tags = cellStr(row.getCell(13).value) || null;
        role = cellStr(row.getCell(14).value) || 'PRIMARY';
        dbType = dt || null;
      } else {
        instanceName = cellStr(row.getCell(1).value);
        hostIp = cellStr(row.getCell(2).value);
        port = cellNum(row.getCell(3).value);
        sid = cellStr(row.getCell(4).value) || null;
        serviceName = cellStr(row.getCell(5).value) || null;
        dbUser = cellStr(row.getCell(6).value) || null;
        const pr = row.getCell(7).value;
        dbPassword = pr != null ? String(pr) : '';
        dbVersion = cellStr(row.getCell(8).value) || null;
        charset = cellStr(row.getCell(9).value) || null;
        environment = cellStr(row.getCell(10).value) || 'PROD';
        bizLine = cellStr(row.getCell(11).value) || null;
        tags = cellStr(row.getCell(12).value) || null;
        role = cellStr(row.getCell(13).value) || 'PRIMARY';
      }

      if (!instanceName || !hostIp) return;
      if (/^示例/i.test(instanceName) || instanceName.includes('示例')) return;

      if (isOther && !dbType) {
        out.push({
          _error: String(ws.name) + ' 第' + String(rowNumber) + '行: 须填写数据库类型列',
          _sheet: ws.name,
          _line: rowNumber,
        });
        return;
      }

      const p = port != null && Number.isFinite(port) ? port : defaultPortForType(dbType);
      const cs = charset && String(charset).trim() ? charset : defaultCharsetForType(dbType);

      out.push({
        instanceName,
        dbType,
        hostIp,
        port: p,
        sid,
        serviceName,
        dbUser,
        dbPassword: dbPassword || null,
        dbVersion,
        charset: cs || null,
        environment: environment || 'PROD',
        bizLine,
        tags,
        role: role || 'PRIMARY',
        clusterName: null,
        hostId: null,
        _sheet: ws.name,
        _line: rowNumber,
      });
    });
  }

  return out;
}

module.exports = {
  buildCmdbInstanceImportTemplate,
  parseCmdbInstanceImportBuffer,
};
