package com.dbops.sqlinsight.audit;

import com.dbops.common.Db;
import com.dbops.common.Values;
import com.dbops.monitor.DbType;
import com.dbops.sqlinsight.ast.Finding;
import com.dbops.sqlinsight.ast.SqlAstService;
import com.dbops.sqlinsight.ast.StaticRuleEngine;
import com.dbops.sqlinsight.ast.TableMetadata;
import com.dbops.sqlinsight.rules.RuleConfigService;
import com.dbops.sqlinsight.store.AssetService;
import com.dbops.sqlinsight.store.InstanceDirectory;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * 统一 SQL 审核引擎：SQL 审核工单 / 治理中心即时审核 / 发布预审 / AI 优化 Agent / SQL 优化建议 全部调用这里，
 * 同一条 SQL 在任何入口得到同一个结论。
 * <p>
 * 组成：Druid AST 静态规则（S-001~S-007、D-001~D-003、H-001~H-003，阈值来自 DI_SQL_RULE）
 * + DDL_AUDIT_RULE 中用户自定义的正则策略（内置的 6 条已由 AST 规则取代并停用）
 * + 可选的目标实例检查（表存在性 / 可执行性 / 执行计划 / 全表扫描）
 * + 资产关联（该 SQL 在线上的运行时问题与波动）。
 * <p>
 * 返回结构兼容原 automation.js sqlAuditCheckDynamic：{issues:[{code,severity,message}], hints, score, risk, instanceCheck}。
 */
@Service
public class SqlAuditService {

    /** 已被 AST 规则取代的内置正则规则编码（迁移脚本会把它们停用；这里再兜底过滤一次） */
    public static final Set<String> SUPERSEDED = Set.of("NO_SELECT_STAR", "WHERE_REQUIRED", "NO_DROP_TABLE", "NO_TRUNCATE",
            "NO_IMPLICIT_CONVERT", "NO_DELETE_LARGE_TABLE", "NO_DELETE_NOINDEX", "NO_DELETE_LARGE", "ADD_COL_DEFAULT", "NO_CARTESIAN",
            "LIMIT_WITHOUT_ORDER");

    public record Request(String sql, String dbType, String schema, Long instanceId, boolean instanceCheck, boolean linkAsset) {
    }

    private record Custom(String code, Pattern pattern, String severity, String message, String dbType) {
    }

    private final SqlAstService ast;
    private final RuleConfigService rules;
    private final ExplainService explain;
    private final AssetService assets;
    private final InstanceDirectory instances;
    private final Db db;
    private volatile List<Custom> custom = List.of();
    private volatile long customAt;

    public SqlAuditService(SqlAstService ast, RuleConfigService rules, ExplainService explain, AssetService assets,
                           InstanceDirectory instances, Db db) {
        this.ast = ast;
        this.rules = rules;
        this.explain = explain;
        this.assets = assets;
        this.instances = instances;
        this.db = db;
    }

    // ------------------------------------------------------------------ 评分（与原实现系数一致）

    public static int score(List<Map<String, Object>> issues) {
        int s = 100;
        for (Map<String, Object> i : issues) {
            s -= switch (Values.str(i.get("severity"), "").toUpperCase(Locale.ROOT)) {
                case "CRITICAL" -> 40;
                case "ERROR" -> 20;
                case "WARNING" -> 8;
                case "INFO" -> 2;
                default -> 0;
            };
        }
        return Math.max(0, s);
    }

    public static String risk(int score) {
        return score >= 90 ? "LOW" : score >= 70 ? "MEDIUM" : score >= 50 ? "HIGH" : "CRITICAL";
    }

    // ------------------------------------------------------------------ 审核

    public Map<String, Object> audit(Request req) {
        String sql = req.sql() == null ? "" : req.sql();
        List<Map<String, Object>> issues = new ArrayList<>();
        List<String> hints = new ArrayList<>();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("engine", "druid-ast");

        if (sql.isBlank()) {
            issues.add(issue("EMPTY_SQL", "ERROR", "SQL 内容不能为空", null));
            return finish(out, issues, hints);
        }
        if (SqlAstService.stripComments(sql).isBlank()) {
            issues.add(issue("EMPTY_SQL", "ERROR", "SQL 内容不能只包含注释", null));
            return finish(out, issues, hints);
        }

        InstanceDirectory.Inst inst = req.instanceId() == null ? null : instances.get(req.instanceId());
        String platform = inst != null ? inst.dbType() : req.dbType();
        SqlAstService.SqlAnalysis a = ast.analyze(sql, platform, req.schema());
        out.put("dbType", a.dbFamily());
        out.put("dialect", a.dialect() == null ? null : a.dialect().name());
        out.put("parsed", a.parsed());
        out.put("stmtType", a.stmtType());
        out.put("statementTypes", a.parsed() ? a.statements().stream().map(SqlAstService::stmtType).toList() : List.of(a.stmtType()));
        out.put("tables", a.tables());
        out.put("fingerprint", a.fingerprint());
        out.put("normalizedSql", a.normalized());

        if (!a.parsed()) {
            if ("UNKNOWN".equals(a.stmtType())) {
                issues.add(issue("INVALID_SQL", "CRITICAL", "输入内容不是有效的 SQL 语句：" + Values.truncate(a.parseError(), 200), null));
                return finish(out, issues, hints);
            }
            issues.add(issue("PARSE_FAILED", "WARNING", "SQL 解析失败，静态规则未执行（不能视为通过）：" + Values.truncate(a.parseError(), 200),
                    "检查语法是否与目标库方言一致"));
        }

        // 静态规则（有实例时读取索引/字段类型元数据）
        RuleConfigService.Scope scope = new RuleConfigService.Scope(null, req.instanceId(), inst == null ? null : inst.bizType(), a.dbFamily());
        StaticRuleEngine.Result res;
        if (inst != null && a.parsed()) {
            res = withMetadata(inst, a, scope);
        } else {
            res = StaticRuleEngine.analyze(a, rules.staticView(scope), TableMetadata.NONE);
        }
        for (Finding f : res.findings()) {
            issues.add(issue(f.code(), f.severity(), f.message(), f.suggestion(), f.title()));
            if (f.code().startsWith("H-") && f.suggestion() != null) {
                hints.add(f.suggestion());
            }
        }
        out.put("skipped", res.skipped().stream().map(Finding.Skipped::toMap).toList());

        // 用户自定义正则策略
        String clean = SqlAstService.stripComments(sql);
        for (Custom c : customRules()) {
            if (c.dbType() != null && !"ALL".equalsIgnoreCase(c.dbType()) && !c.dbType().equalsIgnoreCase(a.dbFamily())
                    && !c.dbType().equalsIgnoreCase(DbType.normalize(platform))) {
                continue;
            }
            try {
                if (c.pattern().matcher(clean).find()) {
                    issues.add(issue(c.code(), c.severity(), c.message(), null));
                }
            } catch (RuntimeException ignore) {
                // 灾难性回溯等异常正则：跳过
            }
        }

        if ("SELECT".equals(a.stmtType()) && !(req.instanceCheck() && inst != null)) {
            hints.add("建议在执行前使用 EXPLAIN 确认执行计划");
        }

        // 目标实例检查
        if (req.instanceCheck() && req.instanceId() != null) {
            Map<String, Object> ic = explain.instanceCheck(req.instanceId(), sql, a.tables(), a.stmtType());
            mergeInstanceCheck(issues, hints, ic);
            out.put("instanceCheck", ic);
        }

        // 资产关联（运行时问题 / 波动史）
        if (req.linkAsset() && a.parsed()) {
            AssetService.AssetRef ref = assets.resolve(a, sql);
            out.put("assetId", ref.assetId());
            out.put("runtime", runtime(ref.assetId(), req.instanceId()));
        }
        return finish(out, issues, hints);
    }

    private StaticRuleEngine.Result withMetadata(InstanceDirectory.Inst inst, SqlAstService.SqlAnalysis a, RuleConfigService.Scope scope) {
        try {
            return explain.withConnection(inst.id(), tdb -> StaticRuleEngine.analyze(a, rules.staticView(scope), new TargetMetadata(tdb, inst.dbType())));
        } catch (Exception e) {
            StaticRuleEngine.Result r = StaticRuleEngine.analyze(a, rules.staticView(scope), TableMetadata.NONE);
            List<Finding.Skipped> sk = new ArrayList<>(r.skipped());
            sk.add(new Finding.Skipped("META", "无法连接目标实例读取元数据：" + Values.truncate(e.getMessage(), 200)));
            return new StaticRuleEngine.Result(r.findings(), sk);
        }
    }

    static void mergeInstanceCheck(List<Map<String, Object>> issues, List<String> hints, Map<String, Object> ic) {
        if (!Boolean.TRUE.equals(ic.get("connected"))) {
            issues.add(issue("DB_UNREACHABLE", "CRITICAL", "无法连接目标实例: " + Values.str(ic.get("connectionError"), "连接失败"), null));
            return;
        }
        Object tl = ic.get("tables");
        if (tl instanceof List<?> list) {
            for (Object o : list) {
                if (o instanceof Map<?, ?> t && !Boolean.TRUE.equals(t.get("exists"))) {
                    String sch = t.get("schema") == null ? "" : t.get("schema") + ".";
                    issues.add(issue("TABLE_NOT_FOUND", "ERROR", "表 " + sch + t.get("name") + " 在实例 [" + ic.get("instanceName") + "] 中不存在", null));
                }
            }
        }
        if (Boolean.FALSE.equals(ic.get("executable"))) {
            issues.add(issue("SQL_NOT_EXECUTABLE", "ERROR", Values.str(ic.get("executeMessage"), "SQL 无法在目标库执行"), null));
        }
        if (Boolean.TRUE.equals(ic.get("explainOk"))) {
            hints.removeIf(h -> h.contains("EXPLAIN"));
        }
        if (Boolean.TRUE.equals(ic.get("fullScanDetected"))) {
            if (hints.stream().noneMatch(h -> h.contains("全表扫描"))) {
                hints.add(0, "【执行计划】检测到全表扫描，建议优化索引或改写 SQL 后再发布");
            }
            for (String s : ExplainService.FULL_SCAN_HINTS) {
                if (!hints.contains(s)) {
                    hints.add(s);
                }
            }
            issues.add(issue("FULL_TABLE_SCAN", "WARNING", "执行计划存在全表扫描，推送发布时将附带优化建议供审核人参考", null));
        }
    }

    private Map<String, Object> runtime(long assetId, Long instanceId) {
        Map<String, Object> m = new LinkedHashMap<>();
        String instCond = instanceId == null ? "" : " AND INSTANCE_ID=" + instanceId.longValue();
        try {
            m.put("openProblems", db.query("SELECT PROBLEM_ID, RULE_CODE, INSTANCE_ID, SEVERITY, DETAIL, LAST_SEEN FROM DI_SQL_PROBLEM WHERE ASSET_ID=? "
                    + "AND STATUS='OPEN'" + instCond + " ORDER BY LAST_SEEN DESC FETCH FIRST 20 ROWS ONLY", assetId));
            m.put("anomalies", db.query("SELECT ANOMALY_ID, INSTANCE_ID, METRIC, ANOMALY_TYPE, SEVERITY, STATUS, RATIO, START_TIME, LAST_TIME FROM DI_SQL_ANOMALY "
                    + "WHERE ASSET_ID=?" + instCond + " AND START_TIME >= SYSTIMESTAMP - INTERVAL '30' DAY ORDER BY START_TIME DESC FETCH FIRST 20 ROWS ONLY", assetId));
            m.put("last24h", db.one("SELECT SUM(D_EXEC) EXECS, ROUND(SUM(D_ELAPSED_MS) / NULLIF(SUM(D_EXEC), 0), 2) AVG_ELAPSED_MS, COUNT(DISTINCT INSTANCE_ID) INSTANCES "
                    + "FROM DI_SQL_STATS_MIN WHERE ASSET_ID=?" + instCond + " AND WINDOW_START >= LOCALTIMESTAMP - INTERVAL '1' DAY", assetId));
        } catch (Exception e) {
            m.put("error", e.getMessage());
        }
        return m;
    }

    private List<Custom> customRules() {
        if (System.currentTimeMillis() - customAt < 30_000) {
            return custom;
        }
        List<Custom> list = new ArrayList<>();
        try {
            for (Map<String, Object> r : db.query("SELECT RULE_CODE, RULE_PATTERN, SEVERITY, MESSAGE, DB_TYPE FROM DDL_AUDIT_RULE WHERE ENABLED=1")) {
                String code = Values.str(r.get("RULE_CODE"), "");
                if (SUPERSEDED.contains(code)) {
                    continue;
                }
                try {
                    list.add(new Custom(code, Pattern.compile(Values.str(r.get("RULE_PATTERN"), "(?!)"), Pattern.CASE_INSENSITIVE | Pattern.DOTALL),
                            Values.str(r.get("SEVERITY"), "WARNING"), Values.str(r.get("MESSAGE"), code), Values.str(r.get("DB_TYPE"))));
                } catch (RuntimeException ignore) {
                    // 非法正则跳过
                }
            }
        } catch (Exception e) {
            if (!Db.isMissingTable(e)) {
                throw e;
            }
        }
        custom = list;
        customAt = System.currentTimeMillis();
        return list;
    }

    private static Map<String, Object> finish(Map<String, Object> out, List<Map<String, Object>> issues, List<String> hints) {
        int s = score(issues);
        out.put("issues", issues);
        out.put("hints", hints);
        out.put("score", s);
        out.put("risk", risk(s));
        out.putIfAbsent("skipped", List.of());
        return out;
    }

    static Map<String, Object> issue(String code, String severity, String message, String suggestion) {
        return issue(code, severity, message, suggestion, null);
    }

    static Map<String, Object> issue(String code, String severity, String message, String suggestion, String title) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("code", code);
        m.put("severity", severity);
        m.put("message", message);
        if (title != null) {
            m.put("title", title);
        }
        if (suggestion != null) {
            m.put("suggestion", suggestion);
        }
        return m;
    }

    // ------------------------------------------------------------------ 兼容输出

    /** /api/sql/optimize 兼容：suggestions [{rule, severity(HIGH/WARN/INFO), desc}] */
    public List<Map<String, Object>> optimizeSuggestions(Map<String, Object> audit) {
        List<Map<String, Object>> out = new ArrayList<>();
        Object is = audit.get("issues");
        if (is instanceof List<?> list) {
            for (Object o : list) {
                if (o instanceof Map<?, ?> i) {
                    String sev = Values.str(i.get("severity"), "INFO").toUpperCase(Locale.ROOT);
                    String mapped = "CRITICAL".equals(sev) || "ERROR".equals(sev) ? "HIGH" : "WARNING".equals(sev) ? "WARN" : "INFO";
                    String desc = Values.str(i.get("message"), "") + (i.get("suggestion") != null ? "；建议：" + i.get("suggestion") : "");
                    out.add(Map.of("rule", Values.str(i.get("code"), ""), "severity", mapped, "desc", desc));
                }
            }
        }
        if (out.isEmpty()) {
            out.add(Map.of("rule", "OK", "severity", "INFO", "desc", "SQL结构检查未发现明显问题，建议结合执行计划进一步分析"));
        }
        return out;
    }
}
