package com.dbops.sqlinsight.rules;

import com.dbops.common.Db;
import com.dbops.common.Values;
import com.dbops.service.SystemConfigService;
import com.dbops.sqlinsight.store.AlertBridge;
import com.dbops.sqlinsight.store.AssetService;
import com.dbops.sqlinsight.store.InstanceDirectory;
import com.dbops.sqlinsight.store.Json;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Collection;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 问题记录（DI_SQL_PROBLEM）：规则命中去重（EVENT_KEY = 规则|实例|资产）、恢复、SKIPPED 原因，
 * 以及 CRITICAL（可配置）问题推送告警中心。
 */
@Service
public class ProblemService {

    private final Db db;
    private final RuleConfigService rules;
    private final AlertBridge alerts;
    private final SystemConfigService cfg;

    public ProblemService(Db db, RuleConfigService rules, AlertBridge alerts, SystemConfigService cfg) {
        this.db = db;
        this.rules = rules;
        this.alerts = alerts;
        this.cfg = cfg;
    }

    public static String key(String code, long instanceId, Object asset) {
        return code + "|" + instanceId + "|" + asset;
    }

    /** 窗口规则结果落库；evaluatedAssets 为本窗口参与评估的资产（未命中的已开问题据此恢复） */
    public int applyWindow(InstanceDirectory.Inst inst, RuntimeRuleEngine.Result res, Collection<Long> evaluatedAssets) {
        Set<String> hitKeys = new HashSet<>();
        int opened = 0;
        // 能力恢复的规则先关闭 SKIPPED 记录，再写本窗口命中：SKIPPED 与 OPEN 共用“活动问题”唯一索引，
        // 原来顺序相反，能力恢复后第一个窗口的命中可能因唯一键冲突被 insertQuietly 吞掉
        if (!res.evaluatedCodes().isEmpty()) {
            List<Object> args = new ArrayList<>();
            args.add(inst.id());
            args.addAll(res.evaluatedCodes());
            db.update("UPDATE DI_SQL_PROBLEM SET STATUS='RESOLVED', RESOLVED_AT=SYSTIMESTAMP, DETAIL='能力已支持' WHERE INSTANCE_ID=? AND STATUS='SKIPPED' "
                    + "AND RULE_CODE IN (" + Db.placeholders(res.evaluatedCodes().size()) + ")", args);
        }
        for (RuntimeRuleEngine.Hit h : res.hits()) {
            String k = key(h.code(), inst.id(), h.assetId());
            hitKeys.add(k);
            opened += upsert(inst, k, h.code(), h.assetId(), h.severity(), h.value(), h.threshold(), h.detail(), h.evidence()) ? 1 : 0;
        }
        // 未再命中 → 恢复（只针对本窗口评估过的规则 + 资产）
        if (!res.evaluatedCodes().isEmpty() && !evaluatedAssets.isEmpty()) {
            List<Object> args = new ArrayList<>();
            args.add(inst.id());
            args.addAll(res.evaluatedCodes());
            for (Map<String, Object> p : db.query("SELECT PROBLEM_ID, EVENT_KEY, ASSET_ID, ALERT_ID FROM DI_SQL_PROBLEM WHERE INSTANCE_ID=? AND STATUS='OPEN' "
                    + "AND RULE_CODE IN (" + Db.placeholders(res.evaluatedCodes().size()) + ")", args)) {
                Long asset = Values.toLong(p.get("ASSET_ID"));
                if (asset != null && evaluatedAssets.contains(asset) && !hitKeys.contains(Values.str(p.get("EVENT_KEY")))) {
                    resolve(p, "指标恢复正常");
                }
            }
        }
        // SKIPPED：能力不支持的规则每实例一条；能力恢复后关闭
        for (RuntimeRuleEngine.Skip s : res.skipped()) {
            String k = key(s.code(), inst.id(), "*");
            int n = db.update("UPDATE DI_SQL_PROBLEM SET LAST_SEEN=SYSTIMESTAMP, DETAIL=? WHERE EVENT_KEY=? AND STATUS='SKIPPED'", s.reason(), k);
            if (n == 0) {
                insertQuietly(k, s.code(), inst.id(), null, "INFO", "SKIPPED", null, null, s.reason(), null);
            }
        }
        return opened;
    }

    /** 会话规则结果落库（P-001/P-002/P-010）；本次采样未命中的会话类问题恢复 */
    public void applySessions(InstanceDirectory.Inst inst, List<RuntimeRuleEngine.SessionHit> hits, boolean supported, String reason) {
        if (!supported) {
            for (String code : RuntimeRuleEngine.SESSION_RULES) {
                String k = key(code, inst.id(), "*");
                int n = db.update("UPDATE DI_SQL_PROBLEM SET LAST_SEEN=SYSTIMESTAMP, DETAIL=? WHERE EVENT_KEY=? AND STATUS='SKIPPED'", reason, k);
                if (n == 0) {
                    insertQuietly(k, code, inst.id(), null, "INFO", "SKIPPED", null, null, reason, null);
                }
            }
            return;
        }
        db.update("UPDATE DI_SQL_PROBLEM SET STATUS='RESOLVED', RESOLVED_AT=SYSTIMESTAMP WHERE INSTANCE_ID=? AND STATUS='SKIPPED' "
                + "AND RULE_CODE IN ('P-001','P-002','P-010')", inst.id());
        Set<String> hitKeys = new HashSet<>();
        for (RuntimeRuleEngine.SessionHit h : hits) {
            if (h.severity() == null) {
                continue;
            }
            Object asset = h.assetId() > 0 ? h.assetId() : "S" + h.sessionKey();
            String k = key(h.code(), inst.id(), asset);
            if (hitKeys.add(k)) {
                upsert(inst, k, h.code(), h.assetId() > 0 ? h.assetId() : null, h.severity(), h.value(), h.threshold(), h.detail(), h.evidence());
            }
        }
        for (Map<String, Object> p : db.query("SELECT PROBLEM_ID, EVENT_KEY, ALERT_ID FROM DI_SQL_PROBLEM WHERE INSTANCE_ID=? AND STATUS='OPEN' "
                + "AND RULE_CODE IN ('P-001','P-002','P-010')", inst.id())) {
            if (!hitKeys.contains(Values.str(p.get("EVENT_KEY")))) {
                resolve(p, "会话已结束或不再满足条件");
            }
        }
    }

    /** 长时间未再出现的窗口类问题（SQL 不再执行）自动恢复 */
    public void resolveStale(long instanceId, int minutes) {
        for (Map<String, Object> p : db.query("SELECT PROBLEM_ID, ALERT_ID FROM DI_SQL_PROBLEM WHERE INSTANCE_ID=? AND STATUS='OPEN' "
                + "AND LAST_SEEN < SYSTIMESTAMP - NUMTODSINTERVAL(?, 'MINUTE')", instanceId, minutes)) {
            resolve(p, minutes + " 分钟内未再出现");
        }
    }

    /** @return 是否新开问题 */
    private boolean upsert(InstanceDirectory.Inst inst, String k, String code, Long asset, String severity, double value, double threshold,
                           String detail, Map<String, Object> evidence) {
        String evJson = evidence == null ? null : Json.write(evidence);
        int n = db.update("UPDATE DI_SQL_PROBLEM SET LAST_SEEN=SYSTIMESTAMP, HIT_COUNT=HIT_COUNT+1, METRIC_VALUE=?, THRESHOLD=?, SEVERITY=?, "
                        + "DETAIL=?, EVIDENCE=? WHERE EVENT_KEY=? AND STATUS='OPEN'",
                round(value), round(threshold), severity, Values.truncate(detail, 2000), evJson, k);
        if (n > 0) {
            return false;
        }
        Long id = insertQuietly(k, code, inst.id(), asset, severity, "OPEN", value, threshold, detail, evJson);
        if (id == null) {
            return false;
        }
        String min = cfg.get("sqlinsight.problem.alert_min_severity", "CRITICAL");
        if (AssetService.rank(severity) >= AssetService.rank(min)) {
            RuleConfigService.RuleSetting s = rules.resolve(code, RuleConfigService.Scope.GLOBAL);
            Map<String, Object> ar = asset == null ? null
                    : db.one("SELECT DBMS_LOB.SUBSTR(SAMPLE_SQL, 200, 1) AS S FROM DI_SQL_ASSET WHERE ASSET_ID=?", asset);
            String sql = ar == null ? "" : Values.str(ar.get("S"), "");
            Long alertId = alerts.fire(AlertBridge.RULE_PROBLEM, inst.id(), inst.name(), severity,
                    String.format("[%s %s] %s%s%s", code, s.name(), detail, asset == null ? "" : "；SQL#" + asset + " ",
                            Values.truncate(sql, 200)));
            if (alertId != null) {
                db.update("UPDATE DI_SQL_PROBLEM SET ALERT_ID=? WHERE PROBLEM_ID=?", alertId, id);
            }
        }
        return true;
    }

    private Long insertQuietly(String k, String code, long instanceId, Long asset, String severity, String status, Double value,
                               Double threshold, String detail, String evidence) {
        try {
            return db.insertReturningId("INSERT INTO DI_SQL_PROBLEM (EVENT_KEY, RULE_CODE, INSTANCE_ID, ASSET_ID, SEVERITY, STATUS, METRIC_VALUE, THRESHOLD, DETAIL, EVIDENCE) "
                            + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", "PROBLEM_ID", k, code, instanceId, asset, severity, status,
                    value == null ? null : round(value), threshold == null ? null : round(threshold), Values.truncate(detail, 2000), evidence);
        } catch (Exception e) {
            if (Db.isUniqueViolation(e)) {
                return null;     // 并发下另一个节点已插入
            }
            throw e;
        }
    }

    public void resolve(Map<String, Object> p, String why) {
        db.update("UPDATE DI_SQL_PROBLEM SET STATUS='RESOLVED', RESOLVED_AT=SYSTIMESTAMP WHERE PROBLEM_ID=? AND STATUS='OPEN'", p.get("PROBLEM_ID"));
        alerts.resolve(p.get("ALERT_ID"), "SQL 问题已恢复：" + why);
    }

    private static double round(double v) {
        return Double.isNaN(v) || Double.isInfinite(v) ? 0 : Values.round(v, 4);
    }
}
