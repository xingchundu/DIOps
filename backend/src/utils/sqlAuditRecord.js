/**
 * SQL 审核记录的公共小工具（SQL 审核工单 / 治理中心 / 发布预审 / 故障自愈 共用）。
 * 审核本身已统一到 Java（utils/sqlInsightClient.js），这里只负责落库与 JSON 处理。
 *
 * 原 services/sqlGovernanceInstanceCheck.js（540 行：5 库连接、表存在性、EXPLAIN、全表扫描识别）已删除，
 * 由 Java ExplainService 取代；本文件只保留其中与落库相关的 toPlainJson / buildPublishReviewResult。
 */
const crypto = require('crypto');
const oracledb = require('oracledb');
const db = require('../config/db');

/** 去除 Oracle 驱动等不可 JSON 序列化的对象，避免 circular structure 错误 */
function toPlainJson(value) {
  const seen = new WeakSet();
  return JSON.parse(JSON.stringify(value === undefined ? null : value, (key, val) => {
    if (val != null && typeof val === 'object') {
      if (seen.has(val)) return undefined;
      seen.add(val);
      const cn = val.constructor?.name || '';
      if (/ConnectDescription|ConnOption|^Connection$|^Pool$/i.test(cn)) return undefined;
    }
    if (typeof val === 'bigint') return String(val);
    if (val instanceof Date) return val.toISOString();
    return val;
  }));
}

/** 推送发布时合并审核 JSON（附带全表扫描优化建议） */
function buildPublishReviewResult(auditResultRaw) {
  let base = {};
  try {
    base = typeof auditResultRaw === 'string' ? JSON.parse(auditResultRaw) : (auditResultRaw || {});
  } catch {
    base = {};
  }
  const ic = base.instanceCheck || {};
  const hints = [...(base.hints || [])];
  const extra = [...(ic.optimizeSuggestions || [])];
  if (ic.fullScanDetected) {
    if (!hints.some((h) => /全表扫描/.test(h))) {
      hints.unshift('【执行计划告警】检测到全表扫描，发布审核请重点关注索引与过滤条件');
    }
    for (const s of extra) {
      if (!hints.includes(s)) hints.push(s);
    }
  }
  return JSON.stringify(toPlainJson({
    ...base,
    hints,
    fullScanDetected: !!ic.fullScanDetected,
    optimizeSuggestions: extra,
    pushedFromGovernance: true,
    pushedAt: new Date().toISOString(),
  }));
}

/** SQL_HASH 列：优先用统一指纹（Java 返回的 fingerprint），兼容旧数据时退回文本 hash */
function auditHash(sqlText, result) {
  if (result && result.fingerprint) return String(result.fingerprint);
  return crypto.createHash('sha256').update(String(sqlText || '').trim().replace(/\s+/g, ' ')).digest('hex').substring(0, 32);
}

/**
 * 写 SQL_AUDIT_RECORD（附 ASSET_ID），返回 AUDIT_ID。
 * 兼容未执行 migration_sql_insight.sql 的库：缺 ASSET_ID / SOURCE 列时逐级降级。
 */
async function insertAuditRecord({ instanceId, sqlText, result, source = 'MANUAL', userId }) {
  const hash = auditHash(sqlText, result);
  const json = JSON.stringify(toPlainJson(result));
  const assetId = result && result.assetId != null ? Number(result.assetId) : null;
  const base = { inst: instanceId || null, sql: sqlText, hash, res: json, score: result?.score ?? null, risk: result?.risk || null, uid: userId || null };
  const variants = [
    [`INSERT INTO SQL_AUDIT_RECORD (INSTANCE_ID,SQL_TEXT,SQL_HASH,AUDIT_RESULT,SCORE,RISK_LEVEL,SOURCE,SUBMITTED_BY,ASSET_ID)
      VALUES (:inst,:sql,:hash,:res,:score,:risk,:src,:uid,:asset) RETURNING AUDIT_ID INTO :id`, { ...base, src: source, asset: assetId }],
    [`INSERT INTO SQL_AUDIT_RECORD (INSTANCE_ID,SQL_TEXT,SQL_HASH,AUDIT_RESULT,SCORE,RISK_LEVEL,SOURCE,SUBMITTED_BY)
      VALUES (:inst,:sql,:hash,:res,:score,:risk,:src,:uid) RETURNING AUDIT_ID INTO :id`, { ...base, src: source }],
    [`INSERT INTO SQL_AUDIT_RECORD (INSTANCE_ID,SQL_TEXT,SQL_HASH,AUDIT_RESULT,SCORE,RISK_LEVEL,SUBMITTED_BY)
      VALUES (:inst,:sql,:hash,:res,:score,:risk,:uid) RETURNING AUDIT_ID INTO :id`, { ...base }],
  ];
  let lastErr;
  for (const [sql, binds] of variants) {
    try {
      const r = await db.execute(sql, { ...binds, id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER } });
      const raw = r?.outBinds?.id;
      const v = Array.isArray(raw) ? raw[0] : raw;
      return v == null ? null : Number(v);
    } catch (e) {
      lastErr = e;
      if (!/ORA-00904/.test(String(e.message))) throw e;   // 只有“列不存在”才降级
    }
  }
  throw lastErr;
}

module.exports = { toPlainJson, buildPublishReviewResult, insertAuditRecord, auditHash };
