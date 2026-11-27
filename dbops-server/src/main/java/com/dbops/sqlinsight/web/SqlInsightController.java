package com.dbops.sqlinsight.web;

import com.dbops.common.BizException;
import com.dbops.common.Db;
import com.dbops.common.R;
import com.dbops.common.Values;
import com.dbops.security.CurrentUser;
import com.dbops.service.AuditService;
import com.dbops.sqlinsight.anomaly.AnomalyService;
import com.dbops.sqlinsight.ast.SqlAstService;
import com.dbops.sqlinsight.audit.ExplainService;
import com.dbops.sqlinsight.audit.SqlAuditService;
import com.dbops.sqlinsight.baseline.BaselineService;
import com.dbops.sqlinsight.collect.Metric;
import com.dbops.sqlinsight.collect.SqlCollectService;
import com.dbops.sqlinsight.diagnosis.DiagnosisService;
import com.dbops.sqlinsight.rules.RuleConfigService;
import com.dbops.sqlinsight.store.AssetService;
import com.dbops.sqlinsight.store.InstanceDirectory;
import com.dbops.sqlinsight.store.Json;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * /api/sql-insight —— SQL 洞察（问题识别 / 波动检测 / 诊断）+ 统一解析/审核/执行计划服务。
 * Node（发布预审、故障自愈、工作台）与 Python AI Agent 通过转发用户 Authorization 调用这里。
 */
@RestController
@RequestMapping("/api/sql-insight")
public class SqlInsightController {

    private final Db db;
    private final SqlAstService ast;
    private final SqlAuditService auditSvc;
    private final ExplainService explain;
    private final SqlCollectService collect;
    private final AnomalyService anomalies;
    private final DiagnosisService diagnosis;
    private final BaselineService baselines;
    private final RuleConfigService rules;
    private final AssetService assets;
    private final InstanceDirectory instances;
    private final AuditService audit;
    private final com.dbops.sqlinsight.store.AlertBridge alerts;

    public SqlInsightController(Db db, SqlAstService ast, SqlAuditService auditSvc, ExplainService explain, SqlCollectService collect,
                                AnomalyService anomalies, DiagnosisService diagnosis, BaselineService baselines, RuleConfigService rules,
                                AssetService assets, InstanceDirectory instances, AuditService audit,
                                com.dbops.sqlinsight.store.AlertBridge alerts) {
        this.alerts = alerts;
        this.db = db;
        this.ast = ast;
        this.auditSvc = auditSvc;
        this.explain = explain;
        this.collect = collect;
        this.anomalies = anomalies;
        this.diagnosis = diagnosis;
        this.baselines = baselines;
        this.rules = rules;
        this.assets = assets;
        this.instances = instances;
        this.audit = audit;
    }

    // ================================================================ 统一解析 / 审核 / 执行计划

    /** 统一审核：{sqlText, dbType?, schema?, instanceId?, instanceCheck?, linkAsset?} */
    @PostMapping("/audit")
    public Map<String, Object> audit(@RequestBody Map<String, Object> b) {
        String sql = Values.str(b.get("sqlText"), Values.str(b.get("sql"), ""));
        Long inst = Values.toLong(b.get("instanceId"));
        boolean check = inst != null && (b.get("instanceCheck") == null || Values.truthy(b.get("instanceCheck")));
        return R.ok(auditSvc.audit(new SqlAuditService.Request(sql, Values.str(b.get("dbType")), Values.str(b.get("schema")), inst, check,
                b.get("linkAsset") == null || Values.truthy(b.get("linkAsset")))));
    }

    /** 语句分类 / 危险语句识别：{sqlText, dbType?} → {types, dangerous} */
    @PostMapping("/classify")
    public Map<String, Object> classify(@RequestBody Map<String, Object> b) {
        String sql = Values.str(b.get("sqlText"), Values.str(b.get("sql"), ""));
        String type = Values.str(b.get("dbType"));
        return R.ok(R.map("types", ast.classify(sql, type), "dangerous", ast.dangerousType(sql, type)));
    }

    /** 指纹：{sqlText, dbType?, schema?} */
    @PostMapping("/fingerprint")
    public Map<String, Object> fingerprint(@RequestBody Map<String, Object> b) {
        SqlAstService.SqlAnalysis a = ast.analyze(Values.str(b.get("sqlText"), ""), Values.str(b.get("dbType")), Values.str(b.get("schema")));
        return R.ok(R.map("fingerprint", a.fingerprint(), "normalized", a.normalized(), "dbType", a.dbFamily(), "schema", a.schema(),
                "stmtType", a.stmtType(), "tables", a.tables(), "parsed", a.parsed(), "parseError", a.parseError()));
    }

    @PostMapping("/explain")
    public Map<String, Object> explain(@RequestBody Map<String, Object> b) {
        Long inst = Values.toLong(b.get("instanceId"));
        String sql = Values.str(b.get("sqlText"), "");
        if (inst == null || sql.isBlank()) {
            return R.badRequest("instanceId和sqlText不能为空");
        }
        return R.ok(explain.explain(inst, sql));
    }

    // ================================================================ 概览 / 资产

    @GetMapping("/overview")
    public Map<String, Object> overview(@RequestParam(required = false) Long instanceId,
                                          @RequestParam(required = false, defaultValue = "1") String hours) {
        String ic = instanceId == null ? "" : " AND INSTANCE_ID=" + instanceId;
        int dbTimeHours = Math.max(1, Math.min(24, Values.toInt(hours, 1)));
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("problems", db.query("SELECT SEVERITY, COUNT(*) CNT FROM DI_SQL_PROBLEM WHERE STATUS='OPEN'" + ic + " GROUP BY SEVERITY"));
        m.put("problemsByRule", db.query("SELECT RULE_CODE, COUNT(*) CNT FROM DI_SQL_PROBLEM WHERE STATUS='OPEN'" + ic + " GROUP BY RULE_CODE ORDER BY CNT DESC"));
        m.put("skipped", db.query("SELECT RULE_CODE, INSTANCE_ID, DETAIL FROM DI_SQL_PROBLEM WHERE STATUS='SKIPPED'" + ic + " ORDER BY RULE_CODE"));
        m.put("anomalies", db.query("SELECT ANOMALY_TYPE, SEVERITY, COUNT(*) CNT FROM DI_SQL_ANOMALY WHERE STATUS='OPEN'" + ic + " GROUP BY ANOMALY_TYPE, SEVERITY"));
        m.put("dbTimeHours", dbTimeHours);
        m.put("dbTimeTop", db.query("SELECT * FROM (SELECT s.ASSET_ID, s.INSTANCE_ID, SUM(s.D_EXEC) EXECS, ROUND(SUM(s.D_ELAPSED_MS), 0) TOTAL_MS, "
                + "ROUND(SUM(s.D_ELAPSED_MS) / NULLIF(SUM(s.D_EXEC), 0), 2) AVG_MS, MAX(a.STMT_TYPE) STMT_TYPE, "
                + "(SELECT MAX(src.NATIVE_ID) KEEP (DENSE_RANK LAST ORDER BY src.LAST_SEEN) FROM DI_SQL_ASSET_SOURCE src WHERE src.ASSET_ID = s.ASSET_ID AND src.INSTANCE_ID = s.INSTANCE_ID) NATIVE_SQL_ID, "
                + "MAX(DBMS_LOB.SUBSTR(a.SAMPLE_SQL, 300, 1)) SQL_TEXT FROM DI_SQL_STATS_MIN s JOIN DI_SQL_ASSET a ON a.ASSET_ID = s.ASSET_ID "
                + "WHERE s.WINDOW_START >= LOCALTIMESTAMP - INTERVAL '" + dbTimeHours + "' HOUR" + ic.replace("INSTANCE_ID", "s.INSTANCE_ID")
                + " GROUP BY s.ASSET_ID, s.INSTANCE_ID ORDER BY TOTAL_MS DESC NULLS LAST) WHERE ROWNUM <= 10"));
        m.put("collect", db.one("SELECT COUNT(DISTINCT INSTANCE_ID) INSTANCES, COUNT(DISTINCT ASSET_ID) ASSETS, MAX(WINDOW_START) LAST_WINDOW "
                + "FROM DI_SQL_STATS_MIN WHERE WINDOW_START >= LOCALTIMESTAMP - INTERVAL '10' MINUTE" + ic));
        if (instanceId != null) {
            m.put("lastError", collect.lastError(instanceId));
            InstanceDirectory.Inst inst = instances.get(instanceId);
            m.put("bizType", inst == null ? null : inst.bizType());
        }
        return R.ok(m);
    }

    @GetMapping("/assets")
    public Map<String, Object> assets(@RequestParam(required = false) Long instanceId, @RequestParam(required = false) String keyword,
                                      @RequestParam(required = false) String isCore, @RequestParam(required = false) String staticRisk,
                                      @RequestParam(required = false) String lifecycle, @RequestParam(required = false) String qualityTag,
                                      @RequestParam(required = false, defaultValue = "1") String page,
                                      @RequestParam(required = false, defaultValue = "20") String size) {
        List<String> where = new ArrayList<>(List.of("1=1"));
        List<Object> args = new ArrayList<>();
        if (instanceId != null) {
            where.add("EXISTS (SELECT 1 FROM DI_SQL_ASSET_SOURCE s WHERE s.ASSET_ID = a.ASSET_ID AND s.INSTANCE_ID = ?)");
            args.add(instanceId);
        }
        if (!Values.isBlank(keyword)) {
            where.add("(DBMS_LOB.INSTR(LOWER(a.NORMALIZED_SQL), ?) > 0 OR a.TABLES LIKE ? OR a.FINGERPRINT = ? "
                    + "OR EXISTS (SELECT 1 FROM DI_SQL_ASSET_SOURCE ks WHERE ks.ASSET_ID = a.ASSET_ID AND (ks.NATIVE_ID = ? OR ks.NATIVE_ID LIKE ?)))");
            args.add(keyword.toLowerCase(Locale.ROOT));
            args.add("%" + keyword.toUpperCase(Locale.ROOT) + "%");
            args.add(keyword);
            args.add(keyword.trim());
            args.add("%|" + keyword.trim() + "%");
        }
        if (!Values.isBlank(lifecycle)) {
            where.add("NVL(a.LIFECYCLE, CASE WHEN a.FIRST_SEEN >= SYSTIMESTAMP - INTERVAL '1' DAY THEN 'NEW' WHEN a.LAST_SEEN < SYSTIMESTAMP - INTERVAL '7' DAY THEN 'DORMANT' ELSE 'ACTIVE' END) = ?");
            args.add(lifecycle.toUpperCase(Locale.ROOT));
        }
        if (!Values.isBlank(qualityTag)) {
            where.add("a.QUALITY_TAG = ?");
            args.add(qualityTag);
        }
        if ("1".equals(isCore)) {
            where.add("a.IS_CORE = 1");
        }
        if (!Values.isBlank(staticRisk)) {
            where.add("a.STATIC_RISK = ?");
            args.add(staticRisk);
        }
        String sql = "SELECT a.ASSET_ID, a.DB_TYPE, a.SCHEMA_NAME, a.FINGERPRINT, a.STMT_TYPE, a.TABLES, a.PARSE_STATUS, a.STATIC_STATUS, "
                + "a.STATIC_RISK, a.IS_CORE, a.BIZ_TYPE, a.OWNER, a.NOTE, a.SCENE, a.APP_VERSION, a.QUALITY_TAG, a.LIFECYCLE, "
                + "NVL(a.LIFECYCLE, CASE WHEN a.FIRST_SEEN >= SYSTIMESTAMP - INTERVAL '1' DAY THEN 'NEW' WHEN a.LAST_SEEN < SYSTIMESTAMP - INTERVAL '7' DAY THEN 'DORMANT' ELSE 'ACTIVE' END) LIFECYCLE_EFF, "
                + "a.FIRST_SEEN, a.LAST_SEEN, DBMS_LOB.SUBSTR(a.SAMPLE_SQL, 500, 1) SQL_TEXT, "
                + "(SELECT MAX(src.NATIVE_ID) KEEP (DENSE_RANK LAST ORDER BY src.LAST_SEEN) FROM DI_SQL_ASSET_SOURCE src WHERE src.ASSET_ID = a.ASSET_ID) NATIVE_SQL_ID, "
                + "(SELECT COUNT(*) FROM DI_SQL_PROBLEM p WHERE p.ASSET_ID = a.ASSET_ID AND p.STATUS = 'OPEN') OPEN_PROBLEMS, "
                + "(SELECT COUNT(*) FROM DI_SQL_ANOMALY x WHERE x.ASSET_ID = a.ASSET_ID AND x.STATUS = 'OPEN') OPEN_ANOMALIES "
                + "FROM DI_SQL_ASSET a WHERE " + String.join(" AND ", where) + " ORDER BY a.LAST_SEEN DESC";
        return R.ok(db.queryPage(sql, args, page, size));
    }

    @GetMapping("/assets/{id}")
    public Map<String, Object> asset(@PathVariable long id, @RequestParam(required = false) Long instanceId) {
        Map<String, Object> a = db.one("SELECT * FROM DI_SQL_ASSET WHERE ASSET_ID=?", id);
        if (a == null) {
            return R.notFound("SQL 资产不存在");
        }
        a.put("STATIC_RESULT", Json.any(Values.str(a.get("STATIC_RESULT"))));
        a.put("sources", db.query("SELECT s.INSTANCE_ID, i.INSTANCE_NAME, s.NATIVE_ID, s.FIRST_SEEN, s.LAST_SEEN FROM DI_SQL_ASSET_SOURCE s "
                + "LEFT JOIN CMDB_INSTANCE i ON i.INSTANCE_ID = s.INSTANCE_ID WHERE s.ASSET_ID=? ORDER BY s.LAST_SEEN DESC FETCH FIRST 200 ROWS ONLY", id));
        a.put("problems", db.query("SELECT * FROM DI_SQL_PROBLEM WHERE ASSET_ID=? ORDER BY LAST_SEEN DESC FETCH FIRST 50 ROWS ONLY", id));
        a.put("anomalies", db.query("SELECT * FROM DI_SQL_ANOMALY WHERE ASSET_ID=? ORDER BY START_TIME DESC FETCH FIRST 50 ROWS ONLY", id));
        a.put("audits", db.query("SELECT AUDIT_ID, SCORE, RISK_LEVEL, SOURCE, CREATED_AT FROM SQL_AUDIT_RECORD WHERE ASSET_ID=? ORDER BY AUDIT_ID DESC "
                + "FETCH FIRST 20 ROWS ONLY", id));
        a.put("anchors", db.query("SELECT * FROM DI_SQL_BASELINE_ANCHOR WHERE ASSET_ID=? ORDER BY ANCHOR_TIME DESC FETCH FIRST 20 ROWS ONLY", id));
        if (instanceId != null) {
            a.put("baselines", baselines.list(instanceId, id));
        }
        return R.ok(a);
    }

    /** 趋势：分钟数据（≤ 24 小时）或小时汇总（> 24 小时） */
    @GetMapping("/assets/{id}/trend")
    public Map<String, Object> trend(@PathVariable long id, @RequestParam long instanceId,
                                     @RequestParam(required = false, defaultValue = "avg_elapsed_ms") String metric,
                                     @RequestParam(required = false, defaultValue = "6") int hours) {
        Metric m = Metric.byKey(metric);
        if (m == null) {
            return R.badRequest("未知指标: " + metric);
        }
        int h = Values.clamp(hours, 1, 24 * 28);
        Timestamp since = new Timestamp(System.currentTimeMillis() - h * 3600_000L);
        String sql = h <= 24
                ? "SELECT WINDOW_START T, PLAN_HASH, " + m.column + " V, D_EXEC EXECS, DATA_QUALITY, ANOMALY_FLAGS FROM DI_SQL_STATS_MIN "
                + "WHERE ASSET_ID=? AND INSTANCE_ID=? AND WINDOW_START >= ? ORDER BY WINDOW_START"
                : "SELECT TRUNC(WINDOW_START, 'HH24') T, MEDIAN(" + m.column + ") V, SUM(D_EXEC) EXECS FROM DI_SQL_STATS_MIN "
                + "WHERE ASSET_ID=? AND INSTANCE_ID=? AND WINDOW_START >= ? GROUP BY TRUNC(WINDOW_START, 'HH24') ORDER BY T";
        return R.ok(R.map("metric", m.key, "label", m.label, "points", db.query(sql, id, instanceId, since),
                "baselines", db.query("SELECT DAY_TYPE, HOUR_OF_DAY, MEDIAN_VAL, MAD_VAL, SAMPLE_COUNT FROM DI_SQL_BASELINE "
                        + "WHERE ASSET_ID=? AND INSTANCE_ID=? AND METRIC=? ORDER BY DAY_TYPE, HOUR_OF_DAY", id, instanceId, m.key)));
    }

    /** 人工标记：核心 SQL / 业务类型 / 负责人 / 备注 */
    @PutMapping("/assets/{id}")
    public Map<String, Object> updateAsset(CurrentUser u, @PathVariable long id, @RequestBody Map<String, Object> b) {
        u.require("ADMIN", "DBA", "OPS");
        String biz = Values.str(b.get("bizType"));
        if (biz != null && !biz.isBlank() && !InstanceDirectory.BIZ_TYPES.contains(biz.toUpperCase(Locale.ROOT))) {
            return R.badRequest("业务类型只能是 OLTP / BATCH / REPORT");
        }
        String life = Values.str(b.get("lifecycle"));
        if (life != null && !life.isBlank() && !List.of("NEW", "ACTIVE", "DEPRECATED", "OFFLINE").contains(life.toUpperCase(Locale.ROOT))) {
            return R.badRequest("生命周期只能是 NEW / ACTIVE / DEPRECATED / OFFLINE");
        }
        db.update("UPDATE DI_SQL_ASSET SET IS_CORE=NVL(?, IS_CORE), BIZ_TYPE=CASE WHEN ? = 1 THEN ? ELSE BIZ_TYPE END, "
                        + "OWNER=CASE WHEN ? = 1 THEN ? ELSE OWNER END, NOTE=CASE WHEN ? = 1 THEN ? ELSE NOTE END, "
                        + "SCENE=CASE WHEN ? = 1 THEN ? ELSE SCENE END, APP_VERSION=CASE WHEN ? = 1 THEN ? ELSE APP_VERSION END, "
                        + "QUALITY_TAG=CASE WHEN ? = 1 THEN ? ELSE QUALITY_TAG END, LIFECYCLE=CASE WHEN ? = 1 THEN ? ELSE LIFECYCLE END WHERE ASSET_ID=?",
                b.containsKey("isCore") ? (Values.truthy(b.get("isCore")) ? 1 : 0) : null,
                b.containsKey("bizType") ? 1 : 0, biz == null || biz.isBlank() ? null : biz.toUpperCase(Locale.ROOT),
                b.containsKey("owner") ? 1 : 0, Values.truncate(Values.str(b.get("owner")), 64),
                b.containsKey("note") ? 1 : 0, Values.truncate(Values.str(b.get("note")), 512),
                b.containsKey("scene") ? 1 : 0, Values.truncate(Values.str(b.get("scene")), 64),
                b.containsKey("appVersion") ? 1 : 0, Values.truncate(Values.str(b.get("appVersion")), 64),
                b.containsKey("qualityTag") ? 1 : 0, Values.truncate(Values.str(b.get("qualityTag")), 64),
                b.containsKey("lifecycle") ? 1 : 0, life == null || life.isBlank() ? null : life.toUpperCase(Locale.ROOT), id);
        assets.invalidate();
        audit.log(u, "SQLINSIGHT_ASSET_UPDATE", "DI_SQL_ASSET", String.valueOf(id), "SUCCESS", Json.write(b));
        return R.msg("已保存");
    }

    /** 实例的业务类型（规则阈值覆盖用） */
    @PutMapping("/instances/{id}/biz-type")
    public Map<String, Object> instanceBizType(CurrentUser u, @PathVariable long id, @RequestBody Map<String, Object> b) {
        u.require("ADMIN", "DBA");
        String biz = Values.str(b.get("bizType"), "OLTP").toUpperCase(Locale.ROOT);
        if (!InstanceDirectory.BIZ_TYPES.contains(biz)) {
            return R.badRequest("业务类型只能是 OLTP / BATCH / REPORT");
        }
        db.update("UPDATE CMDB_INSTANCE SET SQL_BIZ_TYPE=? WHERE INSTANCE_ID=?", biz, id);
        instances.reload();
        audit.log(u, "SQLINSIGHT_BIZ_TYPE", "CMDB_INSTANCE", String.valueOf(id), "SUCCESS", biz);
        return R.msg("已保存");
    }

    // ================================================================ 问题

    @GetMapping("/problems")
    public Map<String, Object> problems(@RequestParam(required = false) Long instanceId, @RequestParam(required = false) Long assetId,
                                        @RequestParam(required = false, defaultValue = "OPEN") String status,
                                        @RequestParam(required = false) String ruleCode, @RequestParam(required = false) String severity,
                                        @RequestParam(required = false, defaultValue = "1") String page,
                                        @RequestParam(required = false, defaultValue = "20") String size) {
        List<String> where = new ArrayList<>(List.of("1=1"));
        List<Object> args = new ArrayList<>();
        filter(where, args, "p.INSTANCE_ID", instanceId);
        filter(where, args, "p.ASSET_ID", assetId);
        if (!"ALL".equalsIgnoreCase(status)) {
            filter(where, args, "p.STATUS", status);
        }
        filter(where, args, "p.RULE_CODE", ruleCode);
        filter(where, args, "p.SEVERITY", severity);
        return R.ok(db.queryPage("SELECT p.*, i.INSTANCE_NAME, r.RULE_NAME, DBMS_LOB.SUBSTR(a.SAMPLE_SQL, 300, 1) SQL_TEXT, "
                + "(SELECT MAX(src.NATIVE_ID) KEEP (DENSE_RANK LAST ORDER BY src.LAST_SEEN) FROM DI_SQL_ASSET_SOURCE src WHERE src.ASSET_ID = p.ASSET_ID AND src.INSTANCE_ID = p.INSTANCE_ID) NATIVE_SQL_ID "
                + "FROM DI_SQL_PROBLEM p "
                + "LEFT JOIN CMDB_INSTANCE i ON i.INSTANCE_ID = p.INSTANCE_ID LEFT JOIN DI_SQL_ASSET a ON a.ASSET_ID = p.ASSET_ID "
                + "LEFT JOIN DI_SQL_RULE r ON r.RULE_CODE = p.RULE_CODE AND r.SCOPE_TYPE = 'GLOBAL' WHERE " + String.join(" AND ", where)
                + " ORDER BY p.LAST_SEEN DESC", args, page, size));
    }

    @PostMapping("/problems/{id}/resolve")
    public Map<String, Object> resolveProblem(CurrentUser u, @PathVariable long id) {
        u.require("ADMIN", "DBA", "OPS");
        Map<String, Object> p = db.one("SELECT PROBLEM_ID, ALERT_ID FROM DI_SQL_PROBLEM WHERE PROBLEM_ID=? AND STATUS='OPEN'", id);
        if (p == null) {
            return R.notFound("问题不存在或已关闭");
        }
        int n = db.update("UPDATE DI_SQL_PROBLEM SET STATUS='RESOLVED', RESOLVED_AT=SYSTIMESTAMP, DETAIL=SUBSTR(DETAIL || ' | 人工关闭：' || ?, 1, 2000) "
                + "WHERE PROBLEM_ID=? AND STATUS='OPEN'", u.username(), id);
        // 与自动恢复（ProblemService.resolve）一致：问题关闭时同步恢复它推送的告警
        if (n > 0 && p.get("ALERT_ID") != null) {
            alerts.resolve(p.get("ALERT_ID"), "SQL 问题已由 " + u.username() + " 人工关闭");
        }
        audit.log(u, "SQLINSIGHT_PROBLEM_RESOLVE", "DI_SQL_PROBLEM", String.valueOf(id), "SUCCESS", null);
        return R.msg("已关闭");
    }

    // ================================================================ 波动事件

    @GetMapping("/anomalies")
    public Map<String, Object> anomalies(@RequestParam(required = false) Long instanceId, @RequestParam(required = false) Long assetId,
                                         @RequestParam(required = false, defaultValue = "OPEN") String status,
                                         @RequestParam(required = false) String type, @RequestParam(required = false) String severity,
                                         @RequestParam(required = false, defaultValue = "1") String page,
                                         @RequestParam(required = false, defaultValue = "20") String size) {
        List<String> where = new ArrayList<>(List.of("1=1"));
        List<Object> args = new ArrayList<>();
        filter(where, args, "x.INSTANCE_ID", instanceId);
        filter(where, args, "x.ASSET_ID", assetId);
        if (!"ALL".equalsIgnoreCase(status)) {
            filter(where, args, "x.STATUS", status);
        }
        filter(where, args, "x.ANOMALY_TYPE", type);
        filter(where, args, "x.SEVERITY", severity);
        return R.ok(db.queryPage("SELECT x.*, i.INSTANCE_NAME, DBMS_LOB.SUBSTR(a.SAMPLE_SQL, 300, 1) SQL_TEXT, "
                + "(SELECT MAX(src.NATIVE_ID) KEEP (DENSE_RANK LAST ORDER BY src.LAST_SEEN) FROM DI_SQL_ASSET_SOURCE src WHERE src.ASSET_ID = x.ASSET_ID AND src.INSTANCE_ID = x.INSTANCE_ID) NATIVE_SQL_ID, "
                + "(SELECT MAX(d.PRIMARY_CAUSE) KEEP (DENSE_RANK LAST ORDER BY d.CREATED_AT) FROM DI_SQL_ANOMALY_DIAGNOSIS d "
                + "WHERE d.ANOMALY_ID = x.ANOMALY_ID AND d.STATUS = 'DONE') PRIMARY_CAUSE FROM DI_SQL_ANOMALY x "
                + "LEFT JOIN CMDB_INSTANCE i ON i.INSTANCE_ID = x.INSTANCE_ID LEFT JOIN DI_SQL_ASSET a ON a.ASSET_ID = x.ASSET_ID WHERE "
                + String.join(" AND ", where) + " ORDER BY x.LAST_TIME DESC NULLS LAST", args, page, size));
    }

    @GetMapping("/anomalies/{id}")
    public Map<String, Object> anomaly(@PathVariable long id) {
        Map<String, Object> ev = db.one("SELECT x.*, i.INSTANCE_NAME, a.SAMPLE_SQL, a.NORMALIZED_SQL, a.IS_CORE FROM DI_SQL_ANOMALY x "
                + "LEFT JOIN CMDB_INSTANCE i ON i.INSTANCE_ID = x.INSTANCE_ID LEFT JOIN DI_SQL_ASSET a ON a.ASSET_ID = x.ASSET_ID WHERE x.ANOMALY_ID=?", id);
        if (ev == null) {
            return R.notFound("事件不存在");
        }
        ev.put("diagnosis", diagnosis.list(id));
        return R.ok(ev);
    }

    @PostMapping("/anomalies/{id}/diagnose")
    public Map<String, Object> diagnose(CurrentUser u, @PathVariable long id) {
        u.require("ADMIN", "DBA", "OPS");
        return R.ok(diagnosis.diagnose(id));
    }

    @PostMapping("/anomalies/{id}/accept")
    public Map<String, Object> accept(CurrentUser u, @PathVariable long id, @RequestBody(required = false) Map<String, Object> b) {
        u.require("ADMIN", "DBA");
        String note = b == null ? null : Values.str(b.get("note"));
        anomalies.accept(id, u.username(), note);
        audit.log(u, "SQLINSIGHT_ACCEPT_BASELINE", "DI_SQL_ANOMALY", String.valueOf(id), "SUCCESS", note);
        return R.msg("已接受为新基线，基线将从现在开始重新积累");
    }

    @PostMapping("/anomalies/{id}/resolve")
    public Map<String, Object> resolveAnomaly(CurrentUser u, @PathVariable long id) {
        u.require("ADMIN", "DBA", "OPS");
        anomalies.resolveManually(id, u.username());
        audit.log(u, "SQLINSIGHT_ANOMALY_RESOLVE", "DI_SQL_ANOMALY", String.valueOf(id), "SUCCESS", null);
        return R.msg("已关闭");
    }

    // ================================================================ 基线锚点（发布 / 优化完成）

    /** {assetId? | sqlText+dbType+schema, instanceId?, reason: PUBLISH/OPTIMIZED/PLAN_CONFIRMED, note} */
    @PostMapping("/anchors")
    public Map<String, Object> anchor(CurrentUser u, @RequestBody Map<String, Object> b) {
        u.require("ADMIN", "DBA", "OPS");
        Long assetId = Values.toLong(b.get("assetId"));
        Long inst = Values.toLong(b.get("instanceId"));
        if (assetId == null) {
            String sql = Values.str(b.get("sqlText"), "");
            if (sql.isBlank()) {
                return R.badRequest("assetId 或 sqlText 必填");
            }
            String type = Values.str(b.get("dbType"));
            if (type == null && inst != null && instances.get(inst) != null) {
                type = instances.get(inst).dbType();
            }
            SqlAstService.SqlAnalysis a = ast.analyze(sql, type, Values.str(b.get("schema")));
            assetId = assets.resolve(a, sql).assetId();
        }
        String reason = Values.str(b.get("reason"), "PUBLISH").toUpperCase(Locale.ROOT);
        if (!List.of("PUBLISH", "OPTIMIZED", "PLAN_CONFIRMED", "ACCEPT_NEW").contains(reason)) {
            return R.badRequest("reason 不合法");
        }
        baselines.anchor(inst, assetId, reason, u.username(), Values.str(b.get("note")));
        return R.ok(R.map("assetId", assetId));
    }

    // ================================================================ 变更窗口

    @GetMapping("/change-windows")
    public Map<String, Object> changeWindows(@RequestParam(required = false) Long instanceId,
                                             @RequestParam(required = false, defaultValue = "1") String page,
                                             @RequestParam(required = false, defaultValue = "20") String size) {
        List<Object> args = new ArrayList<>();
        String w = "";
        if (instanceId != null) {
            w = " WHERE (w.INSTANCE_ID=? OR w.INSTANCE_ID IS NULL)";
            args.add(instanceId);
        }
        return R.ok(db.queryPage("SELECT w.*, i.INSTANCE_NAME FROM DI_CHANGE_WINDOW w LEFT JOIN CMDB_INSTANCE i ON i.INSTANCE_ID = w.INSTANCE_ID"
                + w + " ORDER BY w.START_TIME DESC", args, page, size));
    }

    /** {instanceId?, windowType: RELEASE/BATCH/MAINTENANCE, title, startTime, endTime | durationMinutes, source?, refId?} */
    @PostMapping("/change-windows")
    public Map<String, Object> addChangeWindow(CurrentUser u, @RequestBody Map<String, Object> b) {
        u.require("ADMIN", "DBA", "OPS");
        String type = Values.str(b.get("windowType"), "RELEASE").toUpperCase(Locale.ROOT);
        if (!List.of("RELEASE", "BATCH", "MAINTENANCE").contains(type)) {
            return R.badRequest("窗口类型只能是 RELEASE / BATCH / MAINTENANCE");
        }
        Timestamp start = ts(b.get("startTime"), System.currentTimeMillis());
        Timestamp end = b.get("endTime") != null ? ts(b.get("endTime"), 0)
                : new Timestamp(start.getTime() + Values.clamp(Values.toInt(b.get("durationMinutes"), 60), 1, 7 * 24 * 60) * 60_000L);
        if (!end.after(start)) {
            return R.badRequest("结束时间必须晚于开始时间");
        }
        String source = Values.str(b.get("source"), "MANUAL").toUpperCase(Locale.ROOT);
        Long id = db.insertReturningId("INSERT INTO DI_CHANGE_WINDOW (INSTANCE_ID, WINDOW_TYPE, TITLE, START_TIME, END_TIME, SOURCE, REF_ID, CREATED_BY) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?)", "WINDOW_ID", Values.toLong(b.get("instanceId")), type,
                Values.truncate(Values.str(b.get("title"), type), 256), start, end, "PUBLISH".equals(source) ? "PUBLISH" : "MANUAL",
                Values.truncate(Values.str(b.get("refId")), 64), u.username());
        return R.ok(R.map("windowId", id));
    }

    @DeleteMapping("/change-windows/{id}")
    public Map<String, Object> deleteChangeWindow(CurrentUser u, @PathVariable long id) {
        u.require("ADMIN", "DBA");
        db.update("DELETE FROM DI_CHANGE_WINDOW WHERE WINDOW_ID=?", id);
        return R.msg("已删除");
    }

    // ================================================================ 规则

    @GetMapping("/rules")
    public Map<String, Object> rules(@RequestParam(required = false) String category, @RequestParam(required = false) String ruleCode) {
        return R.ok(rules.list(category, ruleCode));
    }

    @PostMapping("/rules")
    public Map<String, Object> saveRule(CurrentUser u, @RequestBody Map<String, Object> b) {
        u.require("ADMIN", "DBA");
        rules.save(b, u.username());
        audit.log(u, "SQLINSIGHT_RULE_SAVE", "DI_SQL_RULE", Values.str(b.get("ruleCode")), "SUCCESS", Json.write(b));
        return R.msg("已保存");
    }

    @DeleteMapping("/rules/{id}")
    public Map<String, Object> deleteRule(CurrentUser u, @PathVariable long id) {
        u.require("ADMIN", "DBA");
        rules.delete(id);
        audit.log(u, "SQLINSIGHT_RULE_DELETE", "DI_SQL_RULE", String.valueOf(id), "SUCCESS", null);
        return R.msg("已删除");
    }

    // ================================================================ 采集 / 能力

    @GetMapping("/capability")
    public Map<String, Object> capability(@RequestParam long instanceId) {
        return R.ok(R.map("items", db.query("SELECT METRIC, SUPPORTED, SOURCE, DETAIL, PROBED_AT FROM DI_SQL_CAPABILITY WHERE INSTANCE_ID=? ORDER BY METRIC",
                instanceId), "lastError", collect.lastError(instanceId)));
    }

    /** 立即采集（故障自愈 SLOW_QUERY、页面“立即采集”）：返回本轮摘要 + 该实例当前 Top 问题 SQL */
    @PostMapping("/collect/{instanceId}")
    public Map<String, Object> collectNow(CurrentUser u, @PathVariable long instanceId,
                                          @RequestParam(required = false, defaultValue = "0") String reprobe) {
        u.require("ADMIN", "DBA", "OPS");
        if ("1".equals(reprobe)) {
            collect.reprobe(instanceId);
        }
        Map<String, Object> summary = new LinkedHashMap<>(collect.collect(instanceId));
        summary.put("topProblems", db.query("SELECT p.PROBLEM_ID, p.RULE_CODE, p.SEVERITY, p.DETAIL, p.ASSET_ID, a.SAMPLE_SQL SQL_TEXT, a.SCHEMA_NAME, "
                + "(SELECT MAX(src.NATIVE_ID) KEEP (DENSE_RANK LAST ORDER BY src.LAST_SEEN) FROM DI_SQL_ASSET_SOURCE src WHERE src.ASSET_ID = p.ASSET_ID AND src.INSTANCE_ID = p.INSTANCE_ID) NATIVE_SQL_ID "
                + "FROM DI_SQL_PROBLEM p JOIN DI_SQL_ASSET a ON a.ASSET_ID = p.ASSET_ID WHERE p.INSTANCE_ID=? AND p.STATUS='OPEN' "
                + "ORDER BY DECODE(p.SEVERITY, 'CRITICAL', 1, 'WARNING', 2, 3), p.METRIC_VALUE DESC NULLS LAST FETCH FIRST 10 ROWS ONLY", instanceId));
        return R.ok(summary);
    }

    private static void filter(List<String> where, List<Object> args, String col, Object v) {
        if (v != null && !(v instanceof String s && s.isBlank())) {
            where.add(col + "=?");
            args.add(v instanceof String s ? s.trim() : v);
        }
    }

    private static Timestamp ts(Object v, long def) {
        if (v == null || Values.isBlank(v)) {
            if (def == 0) {
                throw BizException.badRequest("时间不能为空");
            }
            return new Timestamp(def);
        }
        Long ms = Values.toStrictLong(v);
        if (ms != null) {
            return new Timestamp(ms);
        }
        try {
            String s = Values.str(v).replace('T', ' ');
            if (s.length() == 16) {
                s += ":00";
            }
            return Timestamp.valueOf(s.length() > 19 ? s.substring(0, 19) : s);
        } catch (Exception e) {
            throw BizException.badRequest("时间格式不正确: " + v);
        }
    }
}
