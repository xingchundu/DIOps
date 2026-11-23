/**
 * SQL 洞察客户端：Node 侧所有 SQL 解析 / 审核 / 执行计划 / 采集 统一调用 Java dbops-server（/api/sql-insight）。
 *
 * 取代原先 Node 内的 4 套正则审核、2 份 isDangerous、540 行 sqlGovernanceInstanceCheck，
 * 保证同一条 SQL 在“SQL 审核 / 治理中心 / 发布预审 / 工作台 / AI 优化”得到同一结论。
 *
 * 鉴权：有用户请求时转发用户的 Authorization（权限与审计跟随真实用户）；
 *       后台任务（故障自愈等）用 JWT_SECRET 签发 2 分钟有效的系统令牌（以一个启用的 ADMIN 账号身份）。
 *
 * 环境变量：JAVA_SERVER_URL（默认 http://127.0.0.1:3000，即 Java 网关端口）
 */
const db = require('../config/db');

const BASE = String(process.env.JAVA_SERVER_URL || `http://127.0.0.1:${process.env.JAVA_SERVER_PORT || 3000}`).replace(/\/+$/, '');
const TIMEOUT_MS = Number(process.env.SQL_INSIGHT_TIMEOUT_MS || 60000);

// 按身份分别缓存（原先单一缓存：先以操作人身份调用后，之后的“系统调用”会沿用该操作人的身份）
const _userCache = new Map();
async function systemAuth(operatorId) {
  const key = operatorId ? `u${operatorId}` : 'admin';
  let c = _userCache.get(key);
  if (!c || Date.now() - c.at > 60000) {
    const r = operatorId
      ? await db.execute(`SELECT USER_ID, USERNAME, ROLE FROM SYS_USER WHERE USER_ID = :1 AND STATUS = 1`, [operatorId])
      : await db.execute(`SELECT USER_ID, USERNAME, ROLE FROM SYS_USER WHERE ROLE = 'ADMIN' AND STATUS = 1 ORDER BY USER_ID FETCH FIRST 1 ROWS ONLY`, []);
    if (!r.rows.length) throw new Error(operatorId ? `操作人 ${operatorId} 不存在或已禁用` : '没有可用于系统调用的启用 ADMIN 账号');
    c = { user: r.rows[0], at: Date.now() };
    _userCache.set(key, c);
  }
  const { signShortToken } = require('../middleware/auth');
  return `Bearer ${signShortToken({ userId: c.user.USER_ID, username: c.user.USERNAME, role: c.user.ROLE })}`;
}

/**
 * @param {object|null} req  Express 请求（取 Authorization）；后台任务传 null
 * @returns data 字段；code != 200 时抛出 Error(msg)，err.code 为业务码
 */
async function call(req, method, path, body, { operatorId } = {}) {
  const auth = req?.headers?.authorization || await systemAuth(operatorId);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(`${BASE}/api/sql-insight${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    let json;
    try { json = await resp.json(); } catch { json = { code: resp.status, msg: `HTTP ${resp.status}` }; }
    if (json.code !== 200) {
      const err = new Error(json.msg || `SQL 洞察服务返回 ${json.code}`);
      err.code = json.code;
      throw err;
    }
    return json.data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`SQL 洞察服务超时（${TIMEOUT_MS}ms）`);
    if (e.code === undefined && /fetch failed|ECONNREFUSED/i.test(String(e.message) + String(e.cause?.code || ''))) {
      const err = new Error(`SQL 洞察服务不可达（${BASE}）：${e.cause?.code || e.message}`);
      err.unreachable = true;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 统一审核：返回 {issues, hints, score, risk, instanceCheck?, assetId?, runtime?, fingerprint, stmtType ...} */
function audit(req, { sqlText, instanceId, dbType, schema, instanceCheck = true, linkAsset = true }, opts) {
  return call(req, 'POST', '/audit', { sqlText, instanceId: instanceId || null, dbType, schema, instanceCheck, linkAsset }, opts);
}

/** 危险语句识别：返回 {types, dangerous} */
function classify(req, sqlText, dbType) {
  return call(req, 'POST', '/classify', { sqlText, dbType });
}

/** 执行计划：返回 {plan, issues, fullScanDetected, dbType} */
function explain(req, instanceId, sqlText) {
  return call(req, 'POST', '/explain', { instanceId, sqlText });
}

/** 基线锚点（发布成功 / 优化完成）：{assetId? | sqlText, dbType?, instanceId?, reason, note} */
function anchor(req, body, opts) {
  return call(req, 'POST', '/anchors', body, opts);
}

/** 变更窗口：{instanceId?, windowType, title, startTime?, endTime? | durationMinutes, source, refId} */
function changeWindow(req, body, opts) {
  return call(req, 'POST', '/change-windows', body, opts);
}

/** 即时采集：返回本轮摘要 + topProblems */
function collectNow(req, instanceId, opts) {
  return call(req, 'POST', `/collect/${Number(instanceId)}`, undefined, opts);
}

/** 审核结果中的 SQL 资产 ID（写入 SQL_AUDIT_RECORD / SQL_REVIEW_TICKET.ASSET_ID） */
function assetIdOf(result) {
  return result && result.assetId != null ? Number(result.assetId) : null;
}

/** 后台任务使用的系统账号 ID（启用的 ADMIN） */
async function systemUserId() {
  await systemAuth();
  return _userCache.get('admin').user.USER_ID;
}

module.exports = { systemUserId, call, audit, classify, explain, anchor, changeWindow, collectNow, assetIdOf, BASE };
