/**
 * AI 知识图谱服务
 *
 * 把巡检、SQL 优化、Oracle SQL_ID 诊断、RCA、知识文档里“发生过什么、原因是什么、怎么处理的”
 * 沉淀为 节点(AI_KG_NODE) + 关系(AI_KG_EDGE)，供 AI 助手检索、前端图谱展示。
 *
 * 设计要点
 *  - 写入永远“尽力而为”：任何写入失败只记日志，不影响主流程（巡检/优化）。
 *  - 节点按 (NODE_TYPE, NODE_KEY) 去重；重复出现只累加 WEIGHT 并刷新 PROPS，这样“反复出现的问题”自然变热。
 *  - 关系按 (SRC,DST,REL) 去重。
 *  - Oracle VARCHAR2 是字节语义：LABEL/NODE_KEY 按字节截断，避免 ORA-12899。
 */
const crypto = require('crypto');
const oracledb = require('oracledb');
// 延迟加载数据库模块：纯函数（sqlKey/byteTrunc）可在无数据库环境下单测
const db = new Proxy({}, { get: (_, k) => require('../config/db')[k] });

const NODE_TYPES = ['INSTANCE', 'SQL', 'TABLE', 'FINDING', 'INSPECTION', 'RCA', 'CAUSE', 'ACTION', 'OPT', 'DIAG', 'KNOWLEDGE', 'TAG', 'NOTE'];

function byteTrunc(s, max) {
  s = String(s == null ? '' : s);
  if (Buffer.byteLength(s, 'utf8') <= max) return s;
  let out = '';
  let n = 0;
  for (const ch of s) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (n + b > max) break;
    out += ch; n += b;
  }
  return out;
}
const md5 = (s) => crypto.createHash('md5').update(String(s || '')).digest('hex');
const sqlKey = (text) => md5(String(text || '').replace(/\s+/g, ' ').trim().toLowerCase());
const jsonOrNull = (o) => { try { return o == null ? null : JSON.stringify(o); } catch (_) { return null; } };
const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch (_) { return null; } };

/** 取/建节点，返回 NODE_ID。使用 MERGE 避免并发下唯一键冲突。 */
async function upsertNode(conn, { type, key, label, props, source, refId, bump = true }) {
  const k = byteTrunc(key, 400);
  const lb = byteTrunc(label || key, 400);
  const p = jsonOrNull(props);
  await conn.execute(
    `MERGE INTO AI_KG_NODE t
       USING (SELECT :1 NODE_TYPE, :2 NODE_KEY FROM dual) s
          ON (t.NODE_TYPE = s.NODE_TYPE AND t.NODE_KEY = s.NODE_KEY)
     WHEN MATCHED THEN UPDATE SET
          t.LABEL = :3,
          t.PROPS = NVL(:4, t.PROPS),
          t.WEIGHT = t.WEIGHT + :5,
          t.SOURCE = NVL(:6, t.SOURCE),
          t.REF_ID = NVL(:7, t.REF_ID),
          t.UPDATED_AT = SYSTIMESTAMP
     WHEN NOT MATCHED THEN INSERT (NODE_TYPE, NODE_KEY, LABEL, PROPS, WEIGHT, SOURCE, REF_ID)
          VALUES (:8, :9, :10, :11, 1, :12, :13)`,
    [type, k, lb, p == null ? null : { val: p, type: oracledb.CLOB }, bump ? 1 : 0, source || null, refId ?? null,
      type, k, lb, p == null ? null : { val: p, type: oracledb.CLOB }, source || null, refId ?? null],
  );
  const r = await conn.execute(`SELECT NODE_ID FROM AI_KG_NODE WHERE NODE_TYPE = :1 AND NODE_KEY = :2`, [type, k],
    { outFormat: oracledb.OUT_FORMAT_OBJECT });
  return r.rows[0].NODE_ID;
}

async function upsertEdge(conn, src, dst, rel, props) {
  if (!src || !dst || src === dst) return;
  const p = jsonOrNull(props);
  await conn.execute(
    `MERGE INTO AI_KG_EDGE t
       USING (SELECT :1 SRC_ID, :2 DST_ID, :3 REL_TYPE FROM dual) s
          ON (t.SRC_ID = s.SRC_ID AND t.DST_ID = s.DST_ID AND t.REL_TYPE = s.REL_TYPE)
     WHEN MATCHED THEN UPDATE SET t.WEIGHT = t.WEIGHT + 1, t.UPDATED_AT = SYSTIMESTAMP,
          t.PROPS = NVL(:4, t.PROPS)
     WHEN NOT MATCHED THEN INSERT (SRC_ID, DST_ID, REL_TYPE, PROPS) VALUES (:5, :6, :7, :8)`,
    [src, dst, rel, p == null ? null : { val: p, type: oracledb.CLOB }, src, dst, rel, p == null ? null : { val: p, type: oracledb.CLOB }],
  );
}

/** 把一组写入放进一个事务，失败整体回滚；返回 fn 结果，失败抛出（调用方决定是否吞掉）。 */
function tx(fn) { return db.withTransaction(fn); }

// ---------------------------------------------------------------- 写入：巡检
async function recordInspection({ taskId, reportId, instance, score, status, findings = [] }) {
  if (!instance || instance.id == null) return null;
  return tx(async (conn) => {
    const inst = await upsertNode(conn, {
      type: 'INSTANCE', key: `INSTANCE:${instance.id}`, label: instance.name || `实例${instance.id}`,
      props: { id: instance.id, dbType: instance.dbType, host: instance.host }, source: 'INSPECT', refId: instance.id, bump: false,
    });
    const day = new Date().toISOString().slice(0, 10);
    const insp = await upsertNode(conn, {
      type: 'INSPECTION', key: `INSPECTION:${instance.id}:${reportId || day}`,
      label: `${instance.name || instance.id} 巡检 ${day} ${score == null ? '' : score + '分'}`,
      props: { taskId, reportId, score, status, at: new Date().toISOString(), counts: countBy(findings) }, source: 'INSPECT', refId: reportId || null,
    });
    await upsertEdge(conn, insp, inst, 'OF_INSTANCE');

    // 只沉淀 严重/警告；信息级太多会淹没图谱。每次最多 60 个，保证事务体量可控。
    const picked = findings.filter((f) => ['CRITICAL', 'WARNING'].includes(String(f.level || '').toUpperCase())).slice(0, 60);
    for (const f of picked) {
      const fk = `FINDING:${f.category || 'OTHER'}|${f.title}`;
      const fn = await upsertNode(conn, {
        type: 'FINDING', key: fk, label: f.title,
        props: { category: f.category, level: String(f.level || '').toLowerCase(), advice: f.advice, lastDetail: f.detail, lastInstance: instance.name },
        source: 'INSPECT',
      });
      await upsertEdge(conn, insp, fn, 'FOUND', { level: String(f.level || '').toLowerCase() });
      await upsertEdge(conn, inst, fn, 'HAS_FINDING', { level: String(f.level || '').toLowerCase(), at: day });
      if (f.advice) {
        const an = await upsertNode(conn, {
          type: 'ACTION', key: `ACTION:${md5(f.advice).slice(0, 16)}`, label: byteTrunc(f.advice, 200),
          props: { text: f.advice }, source: 'INSPECT',
        });
        await upsertEdge(conn, fn, an, 'FIXED_BY');
      }
    }
    return { inspection: insp, findings: picked.length };
  });
}

function countBy(findings) {
  const c = { critical: 0, warning: 0, info: 0 };
  for (const f of findings) if (c[f.level] != null) c[f.level] += 1;
  return c;
}

// ---------------------------------------------------------------- 写入：SQL 优化
async function recordSqlOpt({ optId, sqlText, dbType, optimizedSql, mode, instanceId, instanceName, rules = [], precheck }) {
  if (!sqlText) return null;
  return tx(async (conn) => {
    const sk = sqlKey(sqlText);
    const sn = await upsertNode(conn, {
      type: 'SQL', key: `SQL:${sk}`, label: byteTrunc(String(sqlText).replace(/\s+/g, ' ').trim(), 160),
      props: { dbType, sql: String(sqlText).slice(0, 4000) }, source: 'SQL_OPT',
    });
    const on = await upsertNode(conn, {
      type: 'OPT', key: `OPT:${optId || md5(sqlText + Date.now())}`, label: `SQL 优化 ${mode || ''} ${new Date().toISOString().slice(0, 10)}`,
      props: { optId, mode, dbType, optimized: optimizedSql ? String(optimizedSql).slice(0, 4000) : null, precheck },
      source: 'SQL_OPT', refId: optId || null,
    });
    await upsertEdge(conn, on, sn, 'OPTIMIZES');
    if (instanceId != null) {
      const inst = await upsertNode(conn, {
        type: 'INSTANCE', key: `INSTANCE:${instanceId}`, label: instanceName || `实例${instanceId}`, source: 'SQL_OPT', refId: instanceId, bump: false,
      });
      await upsertEdge(conn, sn, inst, 'RUNS_ON');
    }
    for (const r of (rules || []).slice(0, 30)) {
      const name = typeof r === 'string' ? r : (r.ruleName || r.name || r.ruleId || r.id);
      if (!name) continue;
      const fn = await upsertNode(conn, {
        type: 'FINDING', key: `FINDING:SQL_RULE|${name}`, label: String(name),
        props: { category: 'SQL_RULE', advice: r.suggestion || r.advice || null }, source: 'SQL_OPT',
      });
      await upsertEdge(conn, sn, fn, 'HAS_FINDING');
    }
    return { sql: sn, opt: on };
  });
}

// ---------------------------------------------------------------- 写入：Oracle SQL_ID 诊断
async function recordDiag({ jobId, instanceId, instanceName, sqlId, findings = [], summary }) {
  return tx(async (conn) => {
    const sn = await upsertNode(conn, {
      type: 'SQL', key: `SQLID:${instanceId}:${sqlId}`, label: `SQL_ID ${sqlId}`,
      props: { instanceId, sqlId, summary }, source: 'DIAG',
    });
    const dn = await upsertNode(conn, {
      type: 'DIAG', key: `DIAG:${jobId}`, label: `SQL_ID ${sqlId} 深度诊断 ${new Date().toISOString().slice(0, 10)}`,
      props: { jobId, count: findings.length }, source: 'DIAG', refId: jobId,
    });
    await upsertEdge(conn, dn, sn, 'DIAGNOSES');
    if (instanceId != null) {
      const inst = await upsertNode(conn, {
        type: 'INSTANCE', key: `INSTANCE:${instanceId}`, label: instanceName || `实例${instanceId}`, source: 'DIAG', refId: instanceId, bump: false,
      });
      await upsertEdge(conn, sn, inst, 'RUNS_ON');
    }
    for (const f of findings.slice(0, 40)) {
      const title = f.title || f.name || f.rule || f.id;
      if (!title) continue;
      const fn = await upsertNode(conn, {
        type: 'FINDING', key: `FINDING:SQL_DIAG|${title}`, label: String(title),
        props: { category: 'SQL_DIAG', level: f.severity || f.level, advice: f.advice || f.suggestion || null }, source: 'DIAG',
      });
      await upsertEdge(conn, sn, fn, 'HAS_FINDING', { level: f.severity || f.level });
      const adv = f.advice || f.suggestion;
      if (adv) {
        const an = await upsertNode(conn, { type: 'ACTION', key: `ACTION:${md5(adv).slice(0, 16)}`, label: byteTrunc(adv, 200), props: { text: adv }, source: 'DIAG' });
        await upsertEdge(conn, fn, an, 'FIXED_BY');
      }
    }
    return { diag: dn };
  });
}

// ---------------------------------------------------------------- 写入：RCA（由 Python agent 经 /api/kg/ingest 调用）
async function recordRca({ rcaId, instanceId, instanceName, title, causes = [], actions = [], summary }) {
  return tx(async (conn) => {
    const rn = await upsertNode(conn, {
      type: 'RCA', key: `RCA:${rcaId || md5(title + Date.now())}`, label: title || `根因分析 ${rcaId || ''}`,
      props: { summary }, source: 'RCA', refId: rcaId || null,
    });
    if (instanceId != null) {
      const inst = await upsertNode(conn, { type: 'INSTANCE', key: `INSTANCE:${instanceId}`, label: instanceName || `实例${instanceId}`, source: 'RCA', refId: instanceId, bump: false });
      await upsertEdge(conn, rn, inst, 'OF_INSTANCE');
    }
    for (const c of causes.slice(0, 10)) {
      const text = typeof c === 'string' ? c : (c.cause || c.title || c.text);
      if (!text) continue;
      const cn = await upsertNode(conn, { type: 'CAUSE', key: `CAUSE:${md5(text).slice(0, 16)}`, label: byteTrunc(text, 200), props: { text }, source: 'RCA' });
      await upsertEdge(conn, rn, cn, 'CAUSED_BY');
      for (const a of actions.slice(0, 10)) {
        const at = typeof a === 'string' ? a : (a.action || a.title || a.text);
        if (!at) continue;
        const an = await upsertNode(conn, { type: 'ACTION', key: `ACTION:${md5(at).slice(0, 16)}`, label: byteTrunc(at, 200), props: { text: at }, source: 'RCA' });
        await upsertEdge(conn, cn, an, 'FIXED_BY');
      }
    }
    return { rca: rn };
  });
}

// ---------------------------------------------------------------- 手工笔记 / 通用关联
async function addNote({ title, content, relateTo = [], userId }) {
  return tx(async (conn) => {
    const nn = await upsertNode(conn, {
      type: 'NOTE', key: `NOTE:${md5(title + content + Date.now()).slice(0, 20)}`, label: title || '笔记',
      props: { content, by: userId }, source: 'MANUAL',
    });
    for (const id of relateTo) await upsertEdge(conn, nn, Number(id), 'RELATED');
    return { nodeId: nn };
  });
}

// ---------------------------------------------------------------- 查询
const rowNode = (r) => ({
  id: r.NODE_ID, type: r.NODE_TYPE, key: r.NODE_KEY, label: r.LABEL, weight: r.WEIGHT, source: r.SOURCE, refId: r.REF_ID,
  props: parse(r.PROPS), updatedAt: r.UPDATED_AT,
});

async function stats() {
  const [n, e] = await Promise.all([
    db.execute(`SELECT NODE_TYPE, COUNT(*) C FROM AI_KG_NODE GROUP BY NODE_TYPE`),
    db.execute(`SELECT REL_TYPE, COUNT(*) C FROM AI_KG_EDGE GROUP BY REL_TYPE`),
  ]);
  return {
    nodes: Object.fromEntries(n.rows.map((r) => [r.NODE_TYPE, r.C])),
    edges: Object.fromEntries(e.rows.map((r) => [r.REL_TYPE, r.C])),
    totalNodes: n.rows.reduce((a, r) => a + r.C, 0),
    totalEdges: e.rows.reduce((a, r) => a + r.C, 0),
  };
}

async function search({ q, type, limit = 30 }) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 200);
  const binds = [];
  const where = [];
  if (type) { binds.push(String(type).toUpperCase()); where.push(`NODE_TYPE = :${binds.length}`); }
  const words = String(q || '').trim().split(/\s+/).filter(Boolean).slice(0, 5);
  for (const w of words) {
    binds.push(`%${w.toLowerCase()}%`);
    where.push(`LOWER(LABEL) LIKE :${binds.length}`);
  }
  const r = await db.execute(
    `SELECT NODE_ID, NODE_TYPE, NODE_KEY, LABEL, PROPS, WEIGHT, SOURCE, REF_ID, UPDATED_AT
       FROM AI_KG_NODE ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY WEIGHT DESC, UPDATED_AT DESC FETCH FIRST ${lim} ROWS ONLY`, binds);
  return r.rows.map(rowNode);
}

/** 以 nodeId 为中心展开 depth 层（最多 3），节点数封顶，避免前端卡死。 */
async function neighborhood(nodeId, depth = 1, maxNodes = 150) {
  depth = Math.min(Math.max(parseInt(depth, 10) || 1, 1), 3);
  const seen = new Set([Number(nodeId)]);
  let frontier = [Number(nodeId)];
  const edges = new Map();
  for (let d = 0; d < depth && frontier.length && seen.size < maxNodes; d += 1) {
    const ph = frontier.map((_, i) => `:${i + 1}`).join(',');
    const ph2 = frontier.map((_, i) => `:${i + 1 + frontier.length}`).join(',');
    const r = await db.execute(
      `SELECT EDGE_ID, SRC_ID, DST_ID, REL_TYPE, WEIGHT FROM AI_KG_EDGE
        WHERE SRC_ID IN (${ph}) OR DST_ID IN (${ph2}) FETCH FIRST 600 ROWS ONLY`, [...frontier, ...frontier]);
    const next = [];
    for (const e of r.rows) {
      edges.set(e.EDGE_ID, e);
      for (const id of [e.SRC_ID, e.DST_ID]) {
        if (!seen.has(id) && seen.size < maxNodes) { seen.add(id); next.push(id); }
      }
    }
    frontier = next;
  }
  const ids = [...seen];
  const ph = ids.map((_, i) => `:${i + 1}`).join(',');
  const nr = await db.execute(
    `SELECT NODE_ID, NODE_TYPE, NODE_KEY, LABEL, PROPS, WEIGHT, SOURCE, REF_ID, UPDATED_AT FROM AI_KG_NODE WHERE NODE_ID IN (${ph})`, ids);
  const nodeIds = new Set(nr.rows.map((x) => x.NODE_ID));
  return {
    nodes: nr.rows.map(rowNode),
    edges: [...edges.values()].filter((e) => nodeIds.has(e.SRC_ID) && nodeIds.has(e.DST_ID))
      .map((e) => ({ id: e.EDGE_ID, source: e.SRC_ID, target: e.DST_ID, rel: e.REL_TYPE, weight: e.WEIGHT })),
  };
}

/** 总览图：权重最高的 N 个节点及它们之间的边。 */
async function overview(limit = 80, type) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 80, 10), 300);
  const binds = [];
  let where = '';
  if (type) { binds.push(String(type).toUpperCase()); where = 'WHERE NODE_TYPE = :1'; }
  const nr = await db.execute(
    `SELECT NODE_ID, NODE_TYPE, NODE_KEY, LABEL, PROPS, WEIGHT, SOURCE, REF_ID, UPDATED_AT
       FROM AI_KG_NODE ${where} ORDER BY WEIGHT DESC, UPDATED_AT DESC FETCH FIRST ${lim} ROWS ONLY`, binds);
  const ids = nr.rows.map((r) => r.NODE_ID);
  if (!ids.length) return { nodes: [], edges: [] };
  const ph = ids.map((_, i) => `:${i + 1}`).join(',');
  const ph2 = ids.map((_, i) => `:${i + 1 + ids.length}`).join(',');
  const er = await db.execute(
    `SELECT EDGE_ID, SRC_ID, DST_ID, REL_TYPE, WEIGHT FROM AI_KG_EDGE WHERE SRC_ID IN (${ph}) AND DST_ID IN (${ph2})`, [...ids, ...ids]);
  return {
    nodes: nr.rows.map(rowNode),
    edges: er.rows.map((e) => ({ id: e.EDGE_ID, source: e.SRC_ID, target: e.DST_ID, rel: e.REL_TYPE, weight: e.WEIGHT })),
  };
}

async function getNode(id) {
  const r = await db.execute(
    `SELECT NODE_ID, NODE_TYPE, NODE_KEY, LABEL, PROPS, WEIGHT, SOURCE, REF_ID, UPDATED_AT FROM AI_KG_NODE WHERE NODE_ID = :1`, [Number(id)]);
  return r.rows[0] ? rowNode(r.rows[0]) : null;
}

async function deleteNode(id) {
  const r = await db.execute(`DELETE FROM AI_KG_NODE WHERE NODE_ID = :1`, [Number(id)]);
  return r.rowsAffected || 0;
}

/**
 * 给 AI 助手用的上下文：按关键词找相关节点 + 一跳邻居，压成一小段文字，控制在 maxChars 内。
 */
async function contextFor(question, maxChars = 1800) {
  const words = String(question || '').split(/[\s，,。；;、]+/).filter((w) => w.length >= 2).slice(0, 5);
  const hits = new Map();
  for (const w of words) {
    for (const n of await search({ q: w, limit: 6 })) hits.set(n.id, n);
  }
  if (!hits.size) return '';
  const lines = [];
  for (const n of [...hits.values()].slice(0, 8)) {
    const g = await neighborhood(n.id, 1, 20);
    const byId = new Map(g.nodes.map((x) => [x.id, x]));
    const rel = g.edges.map((e) => {
      const o = byId.get(e.source === n.id ? e.target : e.source);
      return o ? `${e.rel}→${o.type}:${o.label}` : null;
    }).filter(Boolean).slice(0, 5);
    lines.push(`- [${n.type}] ${n.label}（出现${n.weight}次）${rel.length ? ' 关联: ' + rel.join('；') : ''}`);
  }
  return byteTrunc(lines.join('\n'), maxChars);
}

module.exports = {
  NODE_TYPES, recordInspection, recordSqlOpt, recordDiag, recordRca, addNote,
  stats, search, neighborhood, overview, getNode, deleteNode, contextFor, sqlKey,
};
