/**
 * 巡检脚本解析：把一份脚本（用户在「巡检脚本库」里手工配置的 SQL，或 master 模板）解析成“检查项（section）”列表。
 *
 * 为什么需要：原 Node 执行器只认 “SELECT '>>SECTION: x'” 这一种单行结果集标记，而平台自带模板使用的是
 *   Oracle   PROMPT >>SECTION: 3. [HEALTH] xxx
 *   达梦     PRINT '>>SECTION: 3. [HEALTH] xxx';
 *   PG/磐维  \echo '>>SECTION: 3. [HEALTH] xxx'
 *   MySQL    SELECT '>>SECTION: 3. [HEALTH] xxx' AS section;
 * 其中前三种在 Node 侧被当成 SQL*Plus / psql 命令直接丢弃，检查项标题和分类全部丢失，
 * 所以“手工配置脚本 → 生成 Word”这条链路实际上只有 Python 版（只读模板）能用。这里统一解析，Node 与 Python 的口径一致。
 *
 * 支持的脚本约定：
 *   1. 分段标记    >>SECTION: <序号>. [<分类>] <标题>     （序号、分类可省略；分类：HEALTH/RISK/PARAMETER/SPACE/HA …）
 *   2. 无标记脚本  每条语句一个检查项，标题取语句前一行注释（-- 标题），没有则为“查询 N”
 *   3. 阈值指令    -- @rule col=USED_PCT warn=85 crit=95 title=表空间使用率 [op=>=] [section=关键字] [advice=建议] [cat=SPACE]
 *                  op 支持 >= > <= < = != contains regex；对命中的行生成“发现项”，写进 Word 总结与评分
 */
'use strict';

const { splitSql } = require('./sqlScript');

/** 分类标签 → 报告分类（与 backend/scripts/db_inspection.py SECTION_CATEGORY_MAP 一致） */
const CATEGORY_TAGS = {
  HEALTH: 'HEALTH', PERF: 'HEALTH', BACKUP: 'HEALTH',
  STAT: 'RISK', RISK: 'RISK', 'RISK-DEEP': 'RISK', 'DEEP-RISK': 'RISK',
  PARAMETER: 'PARAMETER', 'PARAMETER-RISK': 'PARAMETER',
  SPACE: 'SPACE', 'SPACE-DEEP': 'SPACE',
  HA: 'HA', 'HA-DEEP': 'HA', ADG: 'HA',
};

const CATEGORY_LABEL = {
  HEALTH: '健康检查', RISK: '风险检查', PARAMETER: '参数检查', SPACE: '空间检查', HA: '高可用检查', OTHER: '其它',
};
const CATEGORY_ORDER = ['HEALTH', 'RISK', 'PARAMETER', 'SPACE', 'HA', 'OTHER'];

const MARKER_RE = />>SECTION:\s*/i;

const SQLPLUS_SET_OPTS = 'LINESIZE|LINES|PAGESIZE|PAGES|TIMING|TIME|FEEDBACK|FEED|VERIFY|VER|TRIMOUT|TRIMSPOOL|ECHO|SERVEROUT|SERVEROUTPUT|HEADING|HEAD|LONG|WRAP|COLSEP|DEFINE|AUTOTRACE|TERMOUT|NUMWIDTH|NUM|SQLBLANKLINES|NEWPAGE|UNDERLINE|ARRAYSIZE|AUTOCOMMIT|SQLPROMPT|SQLTERMINATOR|ESCAPE|NULL';
const SQLPLUS_LINE_RE = new RegExp(
  `^\\s*(PROMPT|SPOOL|WHENEVER|TTITLE|BTITLE|BREAK|COMPUTE|DEFINE|VARIABLE|VAR|REPHEADER|REPFOOTER|COLUMN|COL|PAUSE|CLEAR|ACCEPT|EXIT|QUIT|CONNECT|CONN|STORE|ALTER\\s+SESSION\\s+SET\\s+NLS_)\\b|^\\s*SET\\s+(${SQLPLUS_SET_OPTS})\\b|^\\s*@@?\\S+`, 'i');

function categoryFromTag(tag, title) {
  const t = String(tag || '').trim().toUpperCase();
  if (t && CATEGORY_TAGS[t]) return CATEGORY_TAGS[t];
  if (t) return 'OTHER';
  const up = String(title || '').toUpperCase();
  const m = /\[([A-Z\-]+)\]/.exec(up);
  if (m && CATEGORY_TAGS[m[1]]) return CATEGORY_TAGS[m[1]];
  return null;
}

/** 从含 >>SECTION: 的一行取出标题（去掉引号、结尾分号、AS 别名） */
function titleFromMarkerLine(line) {
  const idx = line.search(MARKER_RE);
  const before = line.slice(0, idx);
  let rest = line.slice(idx).replace(MARKER_RE, '');
  const quote = /(['"])\s*$/.exec(before);
  if (quote) {
    const end = rest.indexOf(quote[1]);
    if (end >= 0) rest = rest.slice(0, end);
  } else {
    rest = rest.replace(/\s+AS\s+\S+\s*;?\s*$/i, '').replace(/[;'"\s]+$/, '');
  }
  return rest.trim();
}

function parseTitle(raw) {
  // "3. [HEALTH] 告警日志" / "[HEALTH] xxx" / "xxx"
  let s = String(raw || '').trim();
  let no = null;
  let tag = '';
  const m1 = /^(\d+)\s*[.、)）]\s*/.exec(s);
  if (m1) { no = Number(m1[1]); s = s.slice(m1[0].length); }
  const m2 = /^\[([A-Za-z_\-]+)\]\s*/.exec(s);
  if (m2) { tag = m2[1]; s = s.slice(m2[0].length); }
  return { no, tag, title: s.trim() };
}

function unquote(v) {
  const s = String(v);
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

/** 解析 -- @rule 指令；非法指令返回 { error } 以便在报告中提示而不是静默忽略 */
function parseRuleDirective(line) {
  const body = line.replace(/^\s*--\s*@rule\b/i, '').trim();
  const kv = {};
  const re = /(\w+)=("[^"]*"|'[^']*'|\S+)/g;
  let m;
  while ((m = re.exec(body))) kv[m[1].toLowerCase()] = unquote(m[2]);
  if (!kv.col) return { error: `@rule 缺少 col=<列名>：${line.trim().slice(0, 120)}` };
  const op = kv.op || '>=';
  if (!['>=', '>', '<=', '<', '=', '!=', 'contains', 'regex'].includes(op)) {
    return { error: `@rule op 不支持 "${op}"：${line.trim().slice(0, 120)}` };
  }
  if (kv.warn == null && kv.crit == null) return { error: `@rule 至少需要 warn= 或 crit=：${line.trim().slice(0, 120)}` };
  if (op === 'regex') {
    for (const k of ['warn', 'crit']) {
      if (kv[k] != null) {
        try { new RegExp(kv[k], 'i'); } catch { return { error: `@rule ${k} 不是合法正则：${kv[k]}` }; }
      }
    }
  }
  return {
    rule: {
      col: kv.col, op, warn: kv.warn, crit: kv.crit,
      title: kv.title || kv.col, section: kv.section || '', advice: kv.advice || '', cat: kv.cat ? categoryFromTag(kv.cat, '') || 'OTHER' : '',
    },
  };
}

/** 去掉各客户端的“非 SQL”行，并处理 MySQL \G */
function cleanSqlText(text, dbType) {
  const d = String(dbType || '').toUpperCase();
  const oracleLike = d === 'ORACLE' || d === 'DAMENG';
  return String(text || '')
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (/^\\(?![gG]\s*$)/.test(t)) return false;                     // psql 元命令（\echo \set \pset \timing…）
      if (/^PRINT\s+'/i.test(t)) return false;                         // 达梦 PRINT
      if (oracleLike && SQLPLUS_LINE_RE.test(t)) return false;         // SQL*Plus/disql 客户端命令
      if (!oracleLike && /^PROMPT\s/i.test(t)) return false;
      return true;
    })
    .map((line) => line.replace(/\\[gG]\s*;?\s*$/, ';'))               // SHOW SLAVE STATUS\G → ;
    .join('\n');
}

/** 每条语句前的注释作为标题（无分段标记的脚本使用） */
function leadingCommentTitle(stmt) {
  const lines = String(stmt).split('\n');
  for (const l of lines) {
    const t = l.trim();
    if (!t) continue;
    if (t.startsWith('--')) {
      const c = t.replace(/^--+\s*/, '').replace(/[=\-─]{3,}/g, '').trim();
      if (c && !/^@/.test(c)) return c;
      continue;
    }
    break;
  }
  return '';
}

/**
 * @param {string} text 脚本全文
 * @param {string} dbType ORACLE|MYSQL|POSTGRESQL|…
 * @param {{defaultCategory?: string}} [opts]
 * @returns {{ sections: Array<{no:number,title:string,tag:string,category:string,sqls:string[]}>,
 *            preamble: string[], rules: Array, ruleErrors: string[], marked: boolean }}
 */
function parseInspectScript(text, dbType, opts = {}) {
  const src = String(text || '').replace(/\r\n?/g, '\n');
  const defaultCategory = CATEGORY_TAGS[String(opts.defaultCategory || 'HEALTH').toUpperCase()] || 'HEALTH';
  const rules = [];
  const ruleErrors = [];
  const lines = src.split('\n');
  const marked = lines.some((l) => MARKER_RE.test(l));

  // 指令行：先抽出来，其余行进入正文
  const body = [];
  for (const l of lines) {
    if (/^\s*--\s*@rule\b/i.test(l)) {
      const r = parseRuleDirective(l);
      if (r.error) ruleErrors.push(r.error); else rules.push(r.rule);
      continue;
    }
    body.push(l);
  }

  const sections = [];
  const preamble = [];

  if (marked) {
    let cur = null;
    let buf = [];
    const flush = () => {
      const sql = splitSql(cleanSqlText(buf.join('\n'), dbType), dbType);
      if (cur) { cur.sqls = sql; sections.push(cur); } else preamble.push(...sql);
      buf = [];
    };
    for (const l of body) {
      if (MARKER_RE.test(l)) {
        flush();
        const { no, tag, title } = parseTitle(titleFromMarkerLine(l));
        cur = {
          no: no ?? sections.length + 1,
          title: title || `检查项 ${sections.length + 1}`,
          tag,
          category: categoryFromTag(tag, title) || defaultCategory,
          sqls: [],
        };
      } else {
        buf.push(l);
      }
    }
    flush();
    return { sections, preamble, rules, ruleErrors, marked };
  }

  // 无标记：每条语句一个检查项
  const stmts = splitSql(cleanSqlText(body.join('\n'), dbType), dbType);
  let n = 0;
  for (const st of stmts) {
    // SET 之类的会话设置没有结果集，放 preamble 执行
    if (/^\s*(--[^\n]*\n\s*)*SET\s/i.test(st) || /^\s*(--[^\n]*\n\s*)*USE\s/i.test(st)) { preamble.push(st); continue; }
    n += 1;
    const t = leadingCommentTitle(st);
    sections.push({
      no: n,
      title: t || `查询 ${n}`,
      tag: '',
      category: categoryFromTag('', t) || defaultCategory,
      sqls: [st],
    });
  }
  return { sections, preamble, rules, ruleErrors, marked };
}

// ───────────────────────── 只读校验 ─────────────────────────

const READ_ONLY_FIRST = /^(SELECT|WITH|SHOW|EXPLAIN|DESC|DESCRIBE|VALUES|SET|USE|XA\s+RECOVER)\b/i;
const FORBIDDEN_ANYWHERE = [
  [/\bFOR\s+UPDATE\b/i, 'SELECT … FOR UPDATE 会加锁'],
  [/\bINSERT\s+INTO\b/i, '包含 INSERT'],
  [/\bDELETE\s+FROM\b/i, '包含 DELETE'],
  [/\bUPDATE\s+[\w."`\[\]$#]+\s+SET\b/i, '包含 UPDATE'],
  [/\bMERGE\s+INTO\b/i, '包含 MERGE'],
  [/\bINTO\s+(OUTFILE|DUMPFILE)\b/i, '包含 INTO OUTFILE/DUMPFILE'],
  [/\bSELECT\b[\s\S]*?\bINTO\s+(?!@)[\w."`\[\]#]+\s+FROM\b/i, 'SELECT … INTO 会建表'],
  [/\b(DBMS_LOCK\.SLEEP|PG_SLEEP|WAITFOR\s+DELAY)\b/i, '包含休眠调用'],
];

/** 去掉字符串与注释后再做关键字检查，避免 'update' 出现在字面量里被误杀 */
function stripLiteralsAndComments(sql) {
  return String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
}

/**
 * 巡检脚本只允许只读语句：脚本由 ADMIN/DBA 手工配置并在被管生产库上执行，
 * 原执行器对 INSERT/DELETE/DROP/PL/SQL 块一概照跑（Oracle 的 DDL 还会隐式提交）。
 * @returns {string|null} 不允许时返回原因
 */
function readOnlyViolation(stmt) {
  const clean = stripLiteralsAndComments(stmt).trim();
  if (!clean) return null;
  if (!READ_ONLY_FIRST.test(clean)) {
    const first = (/^\S+/.exec(clean) || [''])[0].slice(0, 20);
    return `巡检脚本只允许只读语句（SELECT/WITH/SHOW/EXPLAIN/DESC/SET 会话变量），不允许 ${first}`;
  }
  if (/^SET\s+(GLOBAL|PERSIST|PASSWORD|ROLE|TRANSACTION|CONSTRAINT)/i.test(clean)) {
    return '巡检脚本不允许修改全局参数 / 事务属性';
  }
  for (const [re, why] of FORBIDDEN_ANYWHERE) {
    if (re.test(clean)) return `巡检脚本只允许只读语句：${why}`;
  }
  return null;
}

module.exports = {
  parseInspectScript,
  readOnlyViolation,
  cleanSqlText,
  titleFromMarkerLine,
  parseRuleDirective,
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  CATEGORY_TAGS,
};
