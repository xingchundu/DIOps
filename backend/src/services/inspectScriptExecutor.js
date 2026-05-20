/**
 * 在被管实例连接上执行巡检脚本（INSPECT_SCRIPT），收集结果集与 >>SECTION: 分段。
 */
const oracledb = require('oracledb');

const SECTION_RE = /^>>SECTION:\s*(.+)$/i;

function stripOracleNoise(sql) {
  return sql
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (!t) return false;
      if (/^--/.test(t)) return false;
      if (/^PROMPT\s/i.test(t)) return false;
      if (/^SET\s/i.test(t)) return false;
      if (/^WHENEVER\s/i.test(t)) return false;
    if (/^SPOOL\s/i.test(t)) return false;
    if (String(line).trim() === '/') return false;
    return true;
    })
    .join('\n');
}

function splitSqlStatements(sql, dialect) {
  const d = String(dialect || 'ORACLE').toUpperCase();
  const text = d === 'ORACLE' ? stripOracleNoise(sql) : sql;
  const out = [];
  let buf = '';
  let inStr = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      buf += ch;
      if (ch === inStr && text[i - 1] !== '\\') inStr = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inStr = ch;
      buf += ch;
      continue;
    }
    if (ch === ';') {
      const s = buf.trim();
      if (s) out.push(s);
      buf = '';
      continue;
    }
    buf += ch;
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out.filter(Boolean);
}

function rowToPlain(row) {
  const o = {};
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (v != null && typeof v === 'object' && v.constructor && v.constructor.name === 'Date') {
      o[k] = v.toISOString ? v.toISOString() : String(v);
    } else if (Buffer.isBuffer(v)) {
      o[k] = v.toString('utf8');
    } else {
      o[k] = v;
    }
  }
  return o;
}

/**
 * @param {string} dialect ORACLE|MYSQL|POSTGRESQL
 * @param {*} conn driver connection
 * @param {string} sqlText
 * @returns {Promise<{ sections: Array<{ title: string, tables: Array<{ columns: string[], rows: object[] }> }>, errors: Array<{ sql:string, error:string }> }>}
 */
async function executeInspectScript(dialect, conn, sqlText) {
  const d = String(dialect || 'ORACLE').toUpperCase();
  const sections = [];
  let cur = null;

  function ensureSection(title) {
    if (!cur || cur.title !== title) {
      cur = { title, tables: [] };
      sections.push(cur);
    }
  }

  function pushTable(columns, rows) {
    if (!cur) ensureSection('查询结果');
    cur.tables.push({ columns, rows });
  }

  const errors = [];
  const stmts = splitSqlStatements(sqlText, d);

  if (d === 'ORACLE') {
    for (const st of stmts) {
      const up = st.trim().substring(0, 20).toUpperCase();
      if (!up || /^BEGIN\b/i.test(st)) {
        try {
          await conn.execute(st, [], { autoCommit: false });
        } catch (e) {
          errors.push({ sql: st.slice(0, 800), error: e.message || String(e) });
        }
        continue;
      }
      try {
        const r = await conn.execute(st, [], {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
          maxRows: 10000,
        });
        const meta = r.metaData;
        const rows = r.rows || [];
        const plain = (rows || []).map(rowToPlain);
        const cols = meta && meta.length ? meta.map((m) => m.name) : plain[0] ? Object.keys(plain[0]) : [];
        if (plain.length === 1 && cols.length === 1) {
          const v = plain[0][cols[0]];
          const s = v != null ? String(v).trim() : '';
          const m = s.match(SECTION_RE);
          if (m) {
            ensureSection(m[1].trim());
            continue;
          }
        }
        if (!cur) ensureSection('巡检输出');
        pushTable(cols, plain);
      } catch (e) {
        errors.push({ sql: st.slice(0, 800), error: e.message || String(e) });
      }
    }
    return { sections, errors };
  }

  if (d === 'MYSQL') {
    for (const st of stmts) {
      const up = st.trim().substring(0, 12).toUpperCase();
      if (!up) continue;
      try {
        const [rows, fields] = await conn.query(st);
        if (!Array.isArray(rows) || rows.length === 0) {
          continue;
        }
        const cols = fields && fields.length ? fields.map((f) => f.name) : Object.keys(rows[0]);
        const plain = rows.map((row) => rowToPlain(row));
        if (plain.length === 1 && cols.length === 1) {
          const v = plain[0][cols[0]];
          const s = v != null ? String(v).trim() : '';
          const m = s.match(SECTION_RE);
          if (m) {
            ensureSection(m[1].trim());
            continue;
          }
        }
        if (!cur) ensureSection('巡检输出');
        pushTable(cols, plain);
      } catch (e) {
        errors.push({ sql: st.slice(0, 800), error: e.message || String(e) });
      }
    }
    return { sections, errors };
  }

  if (d === 'POSTGRESQL') {
    for (const st of stmts) {
      const up = st.trim().substring(0, 12).toUpperCase();
      if (!up || up.startsWith('\\')) continue;
      try {
        const r = await conn.query(st);
        const rows = r.rows || [];
        const cols = r.fields && r.fields.length ? r.fields.map((f) => f.name) : rows[0] ? Object.keys(rows[0]) : [];
        const plain = rows.map((row) => rowToPlain(row));
        if (plain.length === 1 && cols.length === 1) {
          const v = plain[0][cols[0]];
          const s = v != null ? String(v).trim() : '';
          const m = s.match(SECTION_RE);
          if (m) {
            ensureSection(m[1].trim());
            continue;
          }
        }
        if (!cur) ensureSection('巡检输出');
        pushTable(cols, plain);
      } catch (e) {
        errors.push({ sql: st.slice(0, 800), error: e.message || String(e) });
      }
    }
    return { sections, errors };
  }

  throw new Error(`不支持的 DB_TYPE 用于脚本执行: ${d}`);
}

module.exports = { executeInspectScript, splitSqlStatements };
