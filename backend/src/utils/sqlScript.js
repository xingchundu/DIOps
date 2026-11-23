/**
 * SQL 脚本拆分与执行（发布工单、回滚、HA 切换、自愈修复、巡检脚本共用）。
 *
 * 拆分规则：
 *  - 识别单引号字符串、双引号标识符、-- 与 /* *\/ 注释、PostgreSQL $tag$ 美元引号，其中的分号不算语句结束；
 *  - PL/SQL 块（BEGIN / DECLARE / CREATE [OR REPLACE] PROCEDURE|FUNCTION|PACKAGE|TRIGGER|TYPE）内部的分号不拆，
 *    块以单独一行的 "/" 结束；没有 "/" 时一直到脚本末尾都算这个块；
 *  - 其它语句以分号或单独一行的 "/" 结束。
 *
 * 执行：同一连接内按顺序执行，任一条失败立即停止并回滚尚未提交的事务。
 * 注意：Oracle / 达梦 / MySQL 的 DDL 会隐式提交，无法随事务回滚（PostgreSQL / 磐维 / SQL Server 的 DDL 可以）。
 */

const PLSQL_START = /^\s*(BEGIN\b|DECLARE\b|CREATE\s+(OR\s+REPLACE\s+)?(EDITIONABLE\s+|NONEDITIONABLE\s+)?(PROCEDURE|FUNCTION|PACKAGE|TRIGGER|TYPE)\b)/i;

function stripLeadingComments(s) {
  let t = s;
  for (;;) {
    const before = t;
    t = t.replace(/^\s+/, '');
    if (t.startsWith('--')) t = t.replace(/^--[^\n]*\n?/, '');
    else if (t.startsWith('/*')) {
      const end = t.indexOf('*/');
      t = end < 0 ? '' : t.slice(end + 2);
    }
    if (t === before) return t;
  }
}

/** @returns {string[]} 不含结尾分号的语句（PL/SQL 块保留 END; 的分号） */
function splitSql(text, dbType) {
  // PL/SQL 块只对 Oracle / 达梦（及未指定类型）生效；PostgreSQL 用 $$ 引号即可识别函数体
  const t0 = String(dbType || '').toUpperCase();
  const plsql = !['POSTGRESQL', 'PANWEI', 'MYSQL', 'GOLDENDB', 'SQLSERVER'].includes(t0);
  const isBlock = b => plsql && PLSQL_START.test(stripLeadingComments(b));
  const src = String(text || '').replace(/\r\n?/g, '\n');
  const out = [];
  let buf = '';
  let i = 0;
  const n = src.length;

  const flush = (keepSemicolon = false) => {
    let s = buf.trim();
    if (!keepSemicolon) s = s.replace(/;\s*$/, '').trim();
    if (stripLeadingComments(s)) out.push(s);
    buf = '';
  };
  const atLineStart = pos => pos === 0 || src[pos - 1] === '\n';
  const slashLine = pos => {
    if (!atLineStart(pos)) return false;
    const m = /^[ \t]*\/[ \t]*(\n|$)/.exec(src.slice(pos, pos + 64));
    return m ? m[0].length : 0;
  };

  while (i < n) {
    const inBlock = isBlock(buf);
    const sl = slashLine(i);
    if (sl) { // 单独一行的 "/"
      flush(inBlock);
      i += sl;
      continue;
    }
    const c = src[i];
    const c2 = src.slice(i, i + 2);
    if (c2 === '--') {
      const e = src.indexOf('\n', i);
      const end = e < 0 ? n : e + 1;
      buf += src.slice(i, end);
      i = end;
      continue;
    }
    if (c2 === '/*') {
      const e = src.indexOf('*/', i + 2);
      const end = e < 0 ? n : e + 2;
      buf += src.slice(i, end);
      i = end;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === c) {
          if (src[j + 1] === c) { j += 2; continue; } // '' 转义
          break;
        }
        j++;
      }
      buf += src.slice(i, Math.min(n, j + 1));
      i = j + 1;
      continue;
    }
    if (c === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(src.slice(i, i + 40));
      if (m) {
        const tag = m[0];
        const e = src.indexOf(tag, i + tag.length);
        const end = e < 0 ? n : e + tag.length;
        buf += src.slice(i, end);
        i = end;
        continue;
      }
    }
    if (c === ';' && !inBlock) {
      buf += ';';
      flush(false);
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  flush(isBlock(buf));
  return out;
}

function isPlsqlBlock(stmt) {
  return PLSQL_START.test(stripLeadingComments(stmt));
}

/**
 * 在一个连接上执行脚本（事务内）。
 * @param {'ORACLE'|'DAMENG'|'MYSQL'|'GOLDENDB'|'POSTGRESQL'|'PANWEI'|'SQLSERVER'} dbType
 * @param {*} conn 已建立的连接
 * @returns {Promise<{rowsAffected:number, statements:number}>} 失败时抛出带 statementIndex 的错误
 */
async function runScript(dbType, conn, text) {
  const stmts = splitSql(text, dbType);
  if (!stmts.length) throw new Error('SQL 内容为空');
  let rows = 0;
  let idx = 0;
  const t = String(dbType || '').toUpperCase();
  let tx = null;
  try {
    if (t === 'MYSQL' || t === 'GOLDENDB') await conn.beginTransaction();
    else if (t === 'POSTGRESQL' || t === 'PANWEI') await conn.query('BEGIN');
    else if (t === 'SQLSERVER') {
      const mssql = require('mssql');
      tx = new mssql.Transaction(conn);
      await tx.begin();
    }
    for (idx = 0; idx < stmts.length; idx++) {
      const s = stmts[idx];
      if (t === 'ORACLE' || t === 'DAMENG') {
        const r = await conn.execute(s, [], { autoCommit: false });
        rows += r.rowsAffected || 0;
      } else if (t === 'MYSQL' || t === 'GOLDENDB') {
        const [r] = await conn.query(s);
        rows += (r && r.affectedRows) || 0;
      } else if (t === 'POSTGRESQL' || t === 'PANWEI') {
        const r = await conn.query(s);
        rows += r.rowCount || 0;
      } else if (t === 'SQLSERVER') {
        const r = await tx.request().batch(s);
        rows += (r.rowsAffected || []).reduce((a, b) => a + b, 0);
      } else {
        throw new Error(`不支持的数据库类型: ${dbType}`);
      }
    }
    if (t === 'ORACLE' || t === 'DAMENG') await conn.commit();
    else if (t === 'MYSQL' || t === 'GOLDENDB') await conn.commit();
    else if (t === 'POSTGRESQL' || t === 'PANWEI') await conn.query('COMMIT');
    else if (tx) await tx.commit();
    return { rowsAffected: rows, statements: stmts.length };
  } catch (e) {
    try {
      if (t === 'ORACLE' || t === 'DAMENG' || t === 'MYSQL' || t === 'GOLDENDB') await conn.rollback();
      else if (t === 'POSTGRESQL' || t === 'PANWEI') await conn.query('ROLLBACK');
      else if (tx) await tx.rollback();
    } catch { /* 连接已断开时忽略 */ }
    const err = new Error(stmts.length > 1 ? `第 ${idx + 1}/${stmts.length} 条语句执行失败：${e.message}` : e.message);
    err.statementIndex = idx;
    err.statements = stmts.length;
    throw err;
  }
}

module.exports = { splitSql, isPlsqlBlock, runScript };
