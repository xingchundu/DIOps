package com.dbops.sqlinsight.web;

import com.dbops.common.Db;
import com.dbops.common.R;
import com.dbops.common.Values;
import com.dbops.security.CurrentUser;
import com.dbops.service.AuditService;
import com.dbops.sqlinsight.audit.SqlOptimizeService;
import com.dbops.sqlinsight.audit.SqlPrecheckService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * SQL 洞察的“用”：规则优化、监控大屏、执行计划变化、优化工单（治理闭环）。
 * <pre>
 * POST /api/sql-insight/optimize      规则优先的 SQL 优化（审核 → 执行计划 → 索引建议 → 等价改写 → 改写前后计划对比）
 * GET  /api/sql-insight/screen        监控大屏数据（KPI、分钟趋势、问题分布、波动事件流、Top SQL、实例排行、慢 SQL 快照）
 * GET  /api/sql-insight/plan-changes  近 N 小时出现的新执行计划（与前 7 天对比单次耗时）
 * POST /api/sql-insight/tickets       由问题 / 波动生成优化工单（SQL 评审工单，SOURCE=SQL_INSIGHT，同一 SQL 未结束的工单不重复建）
 * </pre>
 */
@RestController
@RequestMapping("/api/sql-insight")
public class SqlInsightOpsController {

    private final Db db;
    private final SqlOptimizeService optimizer;
    private final SqlPrecheckService precheck;
    private final AuditService audit;

    public SqlInsightOpsController(Db db, SqlOptimizeService optimizer, SqlPrecheckService precheck, AuditService audit) {
        this.db = db;
        this.optimizer = optimizer;
        this.precheck = precheck;
        this.audit = audit;
    }

    // ================================================================ 规则优化

    /** {sql, dbType?} 或 {sql, config:{type}} — 静态预检，不依赖 Python Agent */
    @PostMapping("/precheck")
    public Map<String, Object> precheck(@RequestBody Map<String, Object> b) {
        String sql = Values.str(b.get("sql"), "");
        String dbType = Values.str(b.get("dbType"));
        if (dbType == null && b.get("config") instanceof Map<?, ?> cfg) {
            dbType = Values.str(cfg.get("type"));
        }
        if (dbType == null) {
            dbType = "ORACLE";
        }
        return R.ok(precheck.precheck(sql, dbType));
    }

    /** {sqlText, dbType?, schema?, instanceId?} */
    @PostMapping("/optimize")
    public Map<String, Object> optimize(@RequestBody Map<String, Object> b) {
        String sql = Values.str(b.get("sqlText"), Values.str(b.get("sql"), ""));
        if (sql.isBlank()) {
            return R.badRequest("sqlText不能为空");
        }
        if (sql.length() > 200_000) {
            return R.badRequest("SQL 过长（>200KB）");
        }
        return R.ok(optimizer.optimize(sql, Values.str(b.get("dbType")), Values.str(b.get("schema")), Values.toLong(b.get("instanceId"))));
    }

    // ================================================================ 监控大屏

    @GetMapping("/screen")
    public Map<String, Object> screen(@RequestParam(required = false) Long instanceId,
                                      @RequestParam(required = false, defaultValue = "60") int minutes) {
        int mins = Math.max(15, Math.min(minutes, 24 * 60));
        String ic = instanceId == null ? "" : " AND INSTANCE_ID=" + instanceId;
        String sic = ic.replace("INSTANCE_ID", "s.INSTANCE_ID");
        String win = " WINDOW_START >= LOCALTIMESTAMP - NUMTODSINTERVAL(" + mins + ", 'MINUTE')";
        Map<String, Object> m = new LinkedHashMap<>();

        Map<String, Object> k = new LinkedHashMap<>();
        Map<String, Object> c = db.one("SELECT COUNT(DISTINCT INSTANCE_ID) INSTANCES, COUNT(DISTINCT ASSET_ID) ASSETS, MAX(WINDOW_START) LAST_WINDOW "
                + "FROM DI_SQL_STATS_MIN WHERE WINDOW_START >= LOCALTIMESTAMP - INTERVAL '10' MINUTE" + ic);
        if (c != null) {
            k.putAll(c);
        }
        Map<String, Object> load = db.one("SELECT ROUND(SUM(D_EXEC) / " + mins + ", 1) EXEC_PER_MIN, "
                + "ROUND(SUM(D_ELAPSED_MS) / NULLIF(SUM(D_EXEC), 0), 2) AVG_MS, ROUND(SUM(D_ELAPSED_MS) / 1000, 0) DB_TIME_SEC, "
                + "ROUND(SUM(D_ERRORS) / NULLIF(SUM(D_EXEC), 0), 4) ERROR_RATE FROM DI_SQL_STATS_MIN WHERE" + win + ic);
        if (load != null) {
            k.putAll(load);
        }
        k.put("openProblems", count("SELECT COUNT(*) CNT FROM DI_SQL_PROBLEM WHERE STATUS='OPEN'" + ic));
        k.put("criticalProblems", count("SELECT COUNT(*) CNT FROM DI_SQL_PROBLEM WHERE STATUS='OPEN' AND SEVERITY='CRITICAL'" + ic));
        k.put("openAnomalies", count("SELECT COUNT(*) CNT FROM DI_SQL_ANOMALY WHERE STATUS='OPEN'" + ic));
        k.put("slow24h", count("SELECT COUNT(DISTINCT NVL(TO_CHAR(ASSET_ID), SQL_HASH)) CNT FROM SQL_SLOW_SUMMARY WHERE CAPTURE_TIME >= SYSTIMESTAMP - INTERVAL '1' DAY" + ic));
        k.put("planChanges24h", count("SELECT COUNT(*) CNT FROM (SELECT DISTINCT s.INSTANCE_ID, s.ASSET_ID, s.PLAN_HASH FROM DI_SQL_STATS_MIN s "
                + "WHERE s.WINDOW_START >= LOCALTIMESTAMP - INTERVAL '1' DAY AND s.PLAN_HASH <> 'NA'" + sic + newPlanPredicate("INTERVAL '1' DAY") + ")"));
        m.put("kpi", k);

        m.put("trend", db.query("SELECT TRUNC(WINDOW_START, 'MI') T, SUM(D_EXEC) EXECS, ROUND(SUM(D_ELAPSED_MS) / NULLIF(SUM(D_EXEC), 0), 2) AVG_MS, "
                + "ROUND(SUM(D_ELAPSED_MS) / 1000, 1) DB_TIME_SEC, NVL(SUM(D_ERRORS), 0) ERRORS, COUNT(DISTINCT ASSET_ID) ASSETS "
                + "FROM DI_SQL_STATS_MIN WHERE" + win + ic + " GROUP BY TRUNC(WINDOW_START, 'MI') ORDER BY T"));
        m.put("anomalyTrend", db.query("SELECT TRUNC(START_TIME, 'HH24') T, COUNT(*) CNT FROM DI_SQL_ANOMALY "
                + "WHERE START_TIME >= SYSTIMESTAMP - INTERVAL '1' DAY" + ic + " GROUP BY TRUNC(START_TIME, 'HH24') ORDER BY T"));
        m.put("problemsByRule", db.query("SELECT p.RULE_CODE, MAX(r.RULE_NAME) RULE_NAME, COUNT(*) CNT FROM DI_SQL_PROBLEM p "
                + "LEFT JOIN DI_SQL_RULE r ON r.RULE_CODE = p.RULE_CODE AND r.SCOPE_TYPE = 'GLOBAL' WHERE p.STATUS='OPEN'"
                + ic.replace("INSTANCE_ID", "p.INSTANCE_ID") + " GROUP BY p.RULE_CODE ORDER BY CNT DESC"));
        m.put("anomalyFeed", db.query("SELECT * FROM (SELECT x.ANOMALY_ID, x.INSTANCE_ID, i.INSTANCE_NAME, x.ASSET_ID, x.SCOPE, x.METRIC, x.DIRECTION, "
                + "x.ANOMALY_TYPE, x.SEVERITY, x.STATUS, ROUND(x.RATIO, 2) RATIO, x.START_TIME, x.LAST_TIME, "
                + "(SELECT MAX(d.PRIMARY_CAUSE) KEEP (DENSE_RANK LAST ORDER BY d.CREATED_AT) FROM DI_SQL_ANOMALY_DIAGNOSIS d "
                + "WHERE d.ANOMALY_ID = x.ANOMALY_ID AND d.STATUS = 'DONE') PRIMARY_CAUSE, DBMS_LOB.SUBSTR(a.SAMPLE_SQL, 160, 1) SQL_TEXT "
                + "FROM DI_SQL_ANOMALY x LEFT JOIN CMDB_INSTANCE i ON i.INSTANCE_ID = x.INSTANCE_ID LEFT JOIN DI_SQL_ASSET a ON a.ASSET_ID = x.ASSET_ID "
                + "WHERE x.LAST_TIME >= SYSTIMESTAMP - INTERVAL '1' DAY" + ic.replace("INSTANCE_ID", "x.INSTANCE_ID")
                + " ORDER BY DECODE(x.STATUS, 'OPEN', 0, 1), x.LAST_TIME DESC) WHERE ROWNUM <= 20"));
        m.put("topSql", db.query("SELECT * FROM (SELECT s.ASSET_ID, s.INSTANCE_ID, MAX(i.INSTANCE_NAME) INSTANCE_NAME, SUM(s.D_EXEC) EXECS, "
                + "ROUND(SUM(s.D_ELAPSED_MS) / 1000, 1) DB_TIME_SEC, ROUND(SUM(s.D_ELAPSED_MS) / NULLIF(SUM(s.D_EXEC), 0), 2) AVG_MS, "
                + "ROUND(SUM(s.D_LOGICAL_READS) / NULLIF(SUM(s.D_EXEC), 0), 0) LR_PER_EXEC, MAX(a.STMT_TYPE) STMT_TYPE, "
                + "MAX(DBMS_LOB.SUBSTR(a.SAMPLE_SQL, 160, 1)) SQL_TEXT FROM DI_SQL_STATS_MIN s JOIN DI_SQL_ASSET a ON a.ASSET_ID = s.ASSET_ID "
                + "LEFT JOIN CMDB_INSTANCE i ON i.INSTANCE_ID = s.INSTANCE_ID WHERE s." + win.trim() + sic
                + " GROUP BY s.ASSET_ID, s.INSTANCE_ID ORDER BY DB_TIME_SEC DESC NULLS LAST) WHERE ROWNUM <= 10"));
        m.put("instanceRank", db.query("SELECT * FROM (SELECT i.INSTANCE_ID, i.INSTANCE_NAME, i.DB_TYPE, "
                + "NVL(t.DB_TIME_SEC, 0) DB_TIME_SEC, NVL(t.EXECS, 0) EXECS, t.AVG_MS, "
                + "(SELECT COUNT(*) FROM DI_SQL_PROBLEM p WHERE p.INSTANCE_ID = i.INSTANCE_ID AND p.STATUS = 'OPEN') PROBLEMS, "
                + "(SELECT COUNT(*) FROM DI_SQL_ANOMALY x WHERE x.INSTANCE_ID = i.INSTANCE_ID AND x.STATUS = 'OPEN') ANOMALIES "
                + "FROM CMDB_INSTANCE i JOIN (SELECT INSTANCE_ID, ROUND(SUM(D_ELAPSED_MS) / 1000, 1) DB_TIME_SEC, SUM(D_EXEC) EXECS, "
                + "ROUND(SUM(D_ELAPSED_MS) / NULLIF(SUM(D_EXEC), 0), 2) AVG_MS FROM DI_SQL_STATS_MIN WHERE" + win + ic
                + " GROUP BY INSTANCE_ID) t ON t.INSTANCE_ID = i.INSTANCE_ID ORDER BY PROBLEMS + ANOMALIES DESC, DB_TIME_SEC DESC) WHERE ROWNUM <= 10"));
        m.put("slowTop", db.query("SELECT * FROM (SELECT s.SQL_ID ROW_ID, s.INSTANCE_ID, i.INSTANCE_NAME, s.DB_TYPE, s.AVG_ELAPSED, s.MAX_ELAPSED, "
                + "s.EXEC_COUNT, s.FULL_SCAN, s.CAPTURE_TIME, DBMS_LOB.SUBSTR(s.SQL_TEXT, 160, 1) SQL_TEXT FROM SQL_SLOW_SUMMARY s "
                + "LEFT JOIN CMDB_INSTANCE i ON i.INSTANCE_ID = s.INSTANCE_ID WHERE s.CAPTURE_TIME >= SYSTIMESTAMP - INTERVAL '1' DAY" + sic
                + " ORDER BY s.AVG_ELAPSED DESC NULLS LAST) WHERE ROWNUM <= 10"));
        m.put("dbTypes", db.query("SELECT i.DB_TYPE, COUNT(DISTINCT i.INSTANCE_ID) INSTANCES FROM CMDB_INSTANCE i "
                + "WHERE EXISTS (SELECT 1 FROM DI_SQL_STATS_MIN s WHERE s.INSTANCE_ID = i.INSTANCE_ID AND s.WINDOW_START >= LOCALTIMESTAMP - INTERVAL '1' DAY)"
                + ic.replace("INSTANCE_ID", "i.INSTANCE_ID") + " GROUP BY i.DB_TYPE ORDER BY INSTANCES DESC"));
        m.put("minutes", mins);
        return R.ok(m);
    }

    private long count(String sql) {
        try {
            Map<String, Object> r = db.one(sql);
            Long v = r == null ? null : Values.toLong(r.get("CNT"));
            return v == null ? 0 : v;
        } catch (Exception e) {
            return 0;   // 某张表未迁移时大屏其它部分照常显示
        }
    }

    /** s.PLAN_HASH 在窗口之前 7 天没出现过，且该 SQL 之前有过其它计划（排除新上线的 SQL） */
    static String newPlanPredicate(String window) {
        return " AND NOT EXISTS (SELECT 1 FROM DI_SQL_STATS_MIN o WHERE o.INSTANCE_ID = s.INSTANCE_ID AND o.ASSET_ID = s.ASSET_ID "
                + "AND o.PLAN_HASH = s.PLAN_HASH AND o.WINDOW_START < LOCALTIMESTAMP - " + window
                + " AND o.WINDOW_START >= LOCALTIMESTAMP - " + window + " - INTERVAL '7' DAY)"
                + " AND EXISTS (SELECT 1 FROM DI_SQL_STATS_MIN o WHERE o.INSTANCE_ID = s.INSTANCE_ID AND o.ASSET_ID = s.ASSET_ID "
                + "AND o.PLAN_HASH <> s.PLAN_HASH AND o.PLAN_HASH <> 'NA' AND o.WINDOW_START < LOCALTIMESTAMP - " + window
                + " AND o.WINDOW_START >= LOCALTIMESTAMP - " + window + " - INTERVAL '7' DAY)";
    }

    // ================================================================ 执行计划变化

    @GetMapping("/plan-changes")
    public Map<String, Object> planChanges(@RequestParam(required = false) Long instanceId,
                                           @RequestParam(required = false, defaultValue = "24") int hours) {
        int h = Math.max(1, Math.min(hours, 24 * 7));
        String window = "NUMTODSINTERVAL(" + h + ", 'HOUR')";
        String sic = instanceId == null ? "" : " AND s.INSTANCE_ID=" + instanceId;
        List<Map<String, Object>> rows = db.query("SELECT q.*, i.INSTANCE_NAME, i.DB_TYPE, DBMS_LOB.SUBSTR(a.SAMPLE_SQL, 300, 1) SQL_TEXT, a.STMT_TYPE, "
                + "(SELECT ROUND(SUM(o.D_ELAPSED_MS) / NULLIF(SUM(o.D_EXEC), 0), 2) FROM DI_SQL_STATS_MIN o WHERE o.INSTANCE_ID = q.INSTANCE_ID "
                + "AND o.ASSET_ID = q.ASSET_ID AND o.PLAN_HASH <> q.PLAN_HASH AND o.WINDOW_START < q.FIRST_SEEN "
                + "AND o.WINDOW_START >= q.FIRST_SEEN - INTERVAL '7' DAY) OLD_AVG_MS, "
                + "(SELECT MAX(o.PLAN_HASH) KEEP (DENSE_RANK LAST ORDER BY o.WINDOW_START) FROM DI_SQL_STATS_MIN o WHERE o.INSTANCE_ID = q.INSTANCE_ID "
                + "AND o.ASSET_ID = q.ASSET_ID AND o.PLAN_HASH <> q.PLAN_HASH AND o.WINDOW_START < q.FIRST_SEEN) OLD_PLAN_HASH "
                + "FROM (SELECT s.INSTANCE_ID, s.ASSET_ID, s.PLAN_HASH, MIN(s.WINDOW_START) FIRST_SEEN, MAX(s.WINDOW_START) LAST_SEEN, SUM(s.D_EXEC) EXECS, "
                + "ROUND(SUM(s.D_ELAPSED_MS) / NULLIF(SUM(s.D_EXEC), 0), 2) NEW_AVG_MS, "
                + "ROUND(SUM(s.D_LOGICAL_READS) / NULLIF(SUM(s.D_EXEC), 0), 0) NEW_LR_PER_EXEC FROM DI_SQL_STATS_MIN s "
                + "WHERE s.WINDOW_START >= LOCALTIMESTAMP - " + window + " AND s.PLAN_HASH <> 'NA'" + sic + newPlanPredicate(window)
                + " GROUP BY s.INSTANCE_ID, s.ASSET_ID, s.PLAN_HASH) q LEFT JOIN CMDB_INSTANCE i ON i.INSTANCE_ID = q.INSTANCE_ID "
                + "LEFT JOIN DI_SQL_ASSET a ON a.ASSET_ID = q.ASSET_ID ORDER BY q.FIRST_SEEN DESC FETCH FIRST 200 ROWS ONLY");
        for (Map<String, Object> r : rows) {
            Double n = Values.toDouble(r.get("NEW_AVG_MS"));
            Double o = Values.toDouble(r.get("OLD_AVG_MS"));
            Double ratio = n != null && o != null && o > 0 ? n / o : null;
            r.put("RATIO", ratio == null ? null : Values.round(ratio, 2));
            r.put("VERDICT", ratio == null ? "UNKNOWN" : ratio >= 1.5 ? "REGRESSION" : ratio <= 0.67 ? "IMPROVED" : "SIMILAR");
        }
        List<Map<String, Object>> unsupported = db.query("SELECT i.INSTANCE_ID, i.INSTANCE_NAME, i.DB_TYPE FROM CMDB_INSTANCE i WHERE EXISTS "
                + "(SELECT 1 FROM DI_SQL_STATS_MIN s WHERE s.INSTANCE_ID = i.INSTANCE_ID AND s.WINDOW_START >= LOCALTIMESTAMP - INTERVAL '1' HOUR" + sic + ") "
                + "AND NOT EXISTS (SELECT 1 FROM DI_SQL_STATS_MIN s WHERE s.INSTANCE_ID = i.INSTANCE_ID AND s.PLAN_HASH <> 'NA' "
                + "AND s.WINDOW_START >= LOCALTIMESTAMP - INTERVAL '1' HOUR)");
        return R.ok(R.map("list", rows, "hours", h, "unsupported", unsupported,
                "note", "MySQL / PostgreSQL / 磐维 / 达梦 的统计视图不提供计划标识，这些实例不参与计划变化检测"));
    }

    // ================================================================ 优化工单

    /** {problemId} 或 {anomalyId}，可带 note。返回 {ticketId, created} */
    @PostMapping("/tickets")
    public Map<String, Object> createTicket(CurrentUser u, @RequestBody Map<String, Object> b) {
        u.require("ADMIN", "DBA", "OPS");
        Long problemId = Values.toLong(b.get("problemId"));
        Long anomalyId = Values.toLong(b.get("anomalyId"));
        Map<String, Object> src;
        String table;
        String idCol;
        long srcId;
        if (problemId != null) {
            src = db.one("SELECT p.PROBLEM_ID, p.RULE_CODE, p.SEVERITY, p.DETAIL, p.INSTANCE_ID, p.ASSET_ID, p.TICKET_ID, r.RULE_NAME "
                    + "FROM DI_SQL_PROBLEM p LEFT JOIN DI_SQL_RULE r ON r.RULE_CODE = p.RULE_CODE AND r.SCOPE_TYPE = 'GLOBAL' WHERE p.PROBLEM_ID=?", problemId);
            table = "DI_SQL_PROBLEM";
            idCol = "PROBLEM_ID";
            srcId = problemId;
        } else if (anomalyId != null) {
            src = db.one("SELECT ANOMALY_ID, METRIC, DIRECTION, SEVERITY, DETAIL, INSTANCE_ID, ASSET_ID, TICKET_ID, RATIO, "
                    + "(SELECT MAX(d.PRIMARY_CAUSE) KEEP (DENSE_RANK LAST ORDER BY d.CREATED_AT) FROM DI_SQL_ANOMALY_DIAGNOSIS d "
                    + "WHERE d.ANOMALY_ID = x.ANOMALY_ID AND d.STATUS = 'DONE') PRIMARY_CAUSE, "
                    + "(SELECT MAX(DBMS_LOB.SUBSTR(d.REPORT_TEXT, 1200, 1)) KEEP (DENSE_RANK LAST ORDER BY d.CREATED_AT) FROM DI_SQL_ANOMALY_DIAGNOSIS d "
                    + "WHERE d.ANOMALY_ID = x.ANOMALY_ID AND d.STATUS = 'DONE') REPORT FROM DI_SQL_ANOMALY x WHERE ANOMALY_ID=?", anomalyId);
            table = "DI_SQL_ANOMALY";
            idCol = "ANOMALY_ID";
            srcId = anomalyId;
        } else {
            return R.badRequest("problemId 或 anomalyId 必填其一");
        }
        if (src == null) {
            return R.notFound("记录不存在");
        }
        Long assetId = Values.toLong(src.get("ASSET_ID"));
        if (assetId == null) {
            return R.badRequest("实例级事件没有对应的 SQL，无法生成优化工单");
        }
        Long instanceId = Values.toLong(src.get("INSTANCE_ID"));
        Map<String, Object> asset = db.one("SELECT DBMS_LOB.SUBSTR(a.SAMPLE_SQL, 32000, 1) AS SAMPLE_SQL, a.SCHEMA_NAME, a.FINGERPRINT, i.DB_TYPE, i.INSTANCE_NAME "
                + "FROM DI_SQL_ASSET a LEFT JOIN CMDB_INSTANCE i ON i.INSTANCE_ID = ? WHERE a.ASSET_ID = ?", instanceId, assetId);
        String sql = Values.str(b.get("sqlText"));
        if (sql == null || sql.isBlank()) {
            sql = asset == null ? null : Values.str(asset.get("SAMPLE_SQL"));
        }
        if (sql == null || sql.isBlank()) {
            return R.badRequest("该 SQL 资产没有样本文本，无法生成工单");
        }

        Map<String, Object> open = db.one("SELECT TICKET_ID FROM (SELECT TICKET_ID FROM SQL_REVIEW_TICKET WHERE ASSET_ID=? "
                + "AND STATUS IN ('PENDING','IN_REVIEW','CHANGES_REQUESTED') ORDER BY TICKET_ID DESC) WHERE ROWNUM <= 1", assetId);
        if (open != null) {
            Long tid = Values.toLong(open.get("TICKET_ID"));
            db.update("UPDATE " + table + " SET TICKET_ID=? WHERE " + idCol + "=?", tid, srcId);
            return R.ok(R.map("ticketId", tid, "created", false), "该 SQL 已有未结束的优化工单 #" + tid);
        }

        // 规则优化结果作为工单的初始意见（连不上目标库时只做静态分析）
        Map<String, Object> opt = null;
        String optError = null;
        try {
            opt = optimizer.optimize(sql, Values.str(asset.get("DB_TYPE")), Values.str(asset.get("SCHEMA_NAME")), instanceId);
        } catch (Exception e) {
            optError = Values.truncate(e.getMessage(), 300);
        }
        String sev = Values.str(src.get("SEVERITY"), "WARNING");
        String priority = "CRITICAL".equals(sev) ? "URGENT" : "WARNING".equals(sev) ? "HIGH" : "NORMAL";
        String reason = problemId != null
                ? "[" + src.get("RULE_CODE") + "] " + Values.str(src.get("RULE_NAME"), "")
                : "波动 " + Values.str(src.get("METRIC"), "") + (src.get("PRIMARY_CAUSE") != null ? "（" + src.get("PRIMARY_CAUSE") + "）" : "");
        String title = Values.truncate("SQL洞察优化 #" + assetId + " " + reason + " @" + Values.str(asset.get("INSTANCE_NAME"), ""), 250);
        Object score = opt == null ? null : opt.get("score");
        Object risk = opt == null ? null : opt.get("risk");
        Long assignedTo = Values.toLong(b.get("assignedTo"));
        if (assignedTo != null) {
            Map<String, Object> ru = db.one("SELECT USER_ID, ROLE FROM SYS_USER WHERE USER_ID=? AND STATUS=1", assignedTo);
            if (ru == null) {
                return R.badRequest("指定审核人不存在或已禁用");
            }
            String rr = Values.str(ru.get("ROLE"));
            if (!List.of("ADMIN", "DBA", "REVIEWER").contains(rr)) {
                return R.badRequest("审核人须为 ADMIN / DBA / REVIEWER");
            }
        }
        Long ticketId = db.insertReturningId("INSERT INTO SQL_REVIEW_TICKET (TITLE, SQL_TEXT, SQL_HASH, INSTANCE_ID, DB_TYPE, ENVIRONMENT, SOURCE, PRIORITY, "
                        + "SUBMITTED_BY, ASSIGNED_TO, SCORE, RISK_LEVEL, STATUS, ASSET_ID) VALUES (?, ?, ?, ?, ?, 'PROD', 'SQL_INSIGHT', ?, ?, ?, ?, ?, 'PENDING', ?)",
                "TICKET_ID", title, sql, md5(Values.str(asset.get("FINGERPRINT"), sql)), instanceId, asset.get("DB_TYPE"), priority, u.userId(), assignedTo,
                score instanceof Number n ? n.doubleValue() : null, risk == null ? null : String.valueOf(risk), assetId);
        if (ticketId == null) {
            return R.fail(500, "工单写入失败（未取回 TICKET_ID），请检查平台库 SQL_REVIEW_TICKET 表与权限");
        }
        try {
            db.update("UPDATE " + table + " SET TICKET_ID=? WHERE " + idCol + "=?", ticketId, srcId);
        } catch (Exception e) {
            if (Db.isMissingColumn(e)) {
                return R.fail(500, "DI_SQL_PROBLEM/DI_SQL_ANOMALY 缺少 TICKET_ID 列，请执行 sql/init.sql 或 migration_sql_insight.sql");
            }
            throw e;
        }
        db.updateQuietly("INSERT INTO SQL_REVIEW_COMMENT (TICKET_ID, USER_ID, COMMENT_TEXT, COMMENT_TYPE) VALUES (?, ?, ?, 'SYSTEM')",
                ticketId, u.userId(), Values.truncate(comment(problemId != null, src, opt, optError, Values.str(b.get("note"))), 1900));
        audit.log(u, "SQLINSIGHT_TICKET", table, String.valueOf(srcId), "SUCCESS", "ticket=" + ticketId);
        return R.ok(R.map("ticketId", ticketId, "created", true), "已生成优化工单 #" + ticketId);
    }

    static String comment(boolean problem, Map<String, Object> src, Map<String, Object> opt, String optError, String note) {
        StringBuilder sb = new StringBuilder("由 SQL 洞察生成。");
        if (problem) {
            sb.append("问题：[").append(src.get("RULE_CODE")).append("] ").append(Values.str(src.get("DETAIL"), ""));
        } else {
            sb.append("波动：").append(Values.str(src.get("DETAIL"), ""));
            if (src.get("REPORT") != null) {
                sb.append("\n诊断：\n").append(src.get("REPORT"));
            }
        }
        if (note != null && !note.isBlank()) {
            sb.append("\n备注：").append(note);
        }
        if (opt != null && opt.get("actions") instanceof List<?> acts && !acts.isEmpty()) {
            sb.append("\n规则优化建议：");
            int i = 1;
            for (Object a : acts) {
                if (a instanceof Map<?, ?> am && i <= 8) {
                    sb.append("\n").append(i++).append(". ").append(am.get("text"));
                }
            }
        } else if (optError != null) {
            sb.append("\n规则优化未完成：").append(optError);
        }
        return sb.toString();
    }

    static String md5(String s) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("MD5").digest(s.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            return null;
        }
    }
}
