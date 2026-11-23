package com.dbops.sqlinsight.rules;

import com.dbops.common.BizException;
import com.dbops.common.Db;
import com.dbops.common.Values;
import com.dbops.sqlinsight.ast.StaticRuleEngine;
import com.dbops.sqlinsight.store.Json;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * 规则与阈值（DI_SQL_RULE）。覆盖优先级：SQL &gt; 实例 &gt; 业务类型 &gt; 数据库类型 &gt; 全局；
 * 参数按键合并（只覆盖写了的键），启用/级别取最具体的非空值。
 * <p>
 * 同时给静态审核（SqlAuditService）和运行态规则（RuntimeRuleEngine）用，所有入口阈值一致。
 */
@Service
public class RuleConfigService {

    public static final List<String> SCOPE_ORDER = List.of("GLOBAL", "DB_TYPE", "BIZ_TYPE", "INSTANCE", "SQL");
    private static final Set<String> SCOPES = Set.copyOf(SCOPE_ORDER);

    /** 规则作用域：均可为空 */
    public record Scope(Long assetId, Long instanceId, String bizType, String dbFamily) {
        public static final Scope GLOBAL = new Scope(null, null, null, null);
    }

    public record RuleSetting(String code, String name, String category, boolean enabled, String severity,
                              Map<String, Object> params) {
        public double p(String key, double def) {
            Double d = Values.toDouble(params.get(key));
            return d == null ? def : d;
        }
    }

    private record Row(long id, String code, String name, String category, String scopeType, String scopeValue,
                       Integer enabled, String severity, Map<String, Object> params) {
    }

    private final Db db;
    private volatile Map<String, List<Row>> byCode = Map.of();
    private volatile long loadedAt;

    public RuleConfigService(Db db) {
        this.db = db;
    }

    private Map<String, List<Row>> rows() {
        if (System.currentTimeMillis() - loadedAt > 60_000) {
            try {
                reload();
            } catch (RuntimeException e) {
                if (byCode.isEmpty()) {
                    throw e;
                }
                // 已有规则缓存时继续使用旧规则
            }
        }
        return byCode;
    }

    public synchronized void reload() {
        Map<String, List<Row>> m = new HashMap<>();
        try {
            for (Map<String, Object> r : db.query("SELECT RULE_ID, RULE_CODE, RULE_NAME, CATEGORY, SCOPE_TYPE, SCOPE_VALUE, ENABLED, SEVERITY, PARAMS FROM DI_SQL_RULE")) {
                Row row = new Row(Values.toLong(r.get("RULE_ID"), 0), Values.str(r.get("RULE_CODE")), Values.str(r.get("RULE_NAME")),
                        Values.str(r.get("CATEGORY")), Values.str(r.get("SCOPE_TYPE"), "GLOBAL"), Values.str(r.get("SCOPE_VALUE"), "*"),
                        Values.toInt(r.get("ENABLED")), Values.str(r.get("SEVERITY")), Json.map(Values.str(r.get("PARAMS"))));
                m.computeIfAbsent(row.code(), k -> new ArrayList<>()).add(row);
            }
        } catch (Exception e) {
            if (!Db.isMissingTable(e)) {
                // 平台库抖动：沿用上一次的规则，30 秒后再试（原来不更新 loadedAt，之后每次规则判定都会再全表查询一次）
                loadedAt = System.currentTimeMillis() - 30_000;
                throw e;
            }
        }
        byCode = m;
        loadedAt = System.currentTimeMillis();
    }

    public RuleSetting resolve(String code, Scope s) {
        List<Row> list = rows().getOrDefault(code, List.of());
        Row[] picked = new Row[SCOPE_ORDER.size()];
        for (Row r : list) {
            if (matches(r, s)) {
                picked[SCOPE_ORDER.indexOf(r.scopeType())] = r;
            }
        }
        String name = code;
        String category = null;
        boolean enabled = true;
        String severity = null;
        Map<String, Object> params = new LinkedHashMap<>();
        for (Row r : picked) {        // 从全局到 SQL，越具体越后覆盖
            if (r == null) {
                continue;
            }
            if ("GLOBAL".equals(r.scopeType()) || name.equals(code)) {
                name = r.name() == null ? name : r.name();
            }
            category = r.category() == null ? category : r.category();
            if (r.enabled() != null) {
                enabled = r.enabled() == 1;
            }
            if (r.severity() != null && !r.severity().isBlank()) {
                severity = r.severity();
            }
            params.putAll(r.params());
        }
        return new RuleSetting(code, name, category, enabled, severity, params);
    }

    private static boolean matches(Row r, Scope s) {
        String v = r.scopeValue();
        return switch (r.scopeType()) {
            case "GLOBAL" -> true;
            case "DB_TYPE" -> s.dbFamily() != null && v.equalsIgnoreCase(s.dbFamily());
            case "BIZ_TYPE" -> s.bizType() != null && v.equalsIgnoreCase(s.bizType());
            case "INSTANCE" -> s.instanceId() != null && v.equals(String.valueOf(s.instanceId()));
            case "SQL" -> s.assetId() != null && v.equals(String.valueOf(s.assetId()));
            default -> false;
        };
    }

    /** 静态规则视图（S-/D-/H-） */
    public StaticRuleEngine.RuleView staticView(Scope s) {
        Map<String, RuleSetting> memo = new HashMap<>();
        return new StaticRuleEngine.RuleView() {
            private RuleSetting r(String code) {
                return memo.computeIfAbsent(code, c -> resolve(c, s));
            }

            @Override
            public boolean enabled(String code) {
                return r(code).enabled();
            }

            @Override
            public String severity(String code, String def) {
                String v = r(code).severity();
                return v == null ? def : v;
            }

            @Override
            public double param(String code, String key, double def) {
                return r(code).p(key, def);
            }
        };
    }

    // ------------------------------------------------------------------ 管理接口

    public List<Map<String, Object>> list(String category, String code) {
        StringBuilder sql = new StringBuilder("SELECT * FROM DI_SQL_RULE WHERE 1=1");
        List<Object> args = new ArrayList<>();
        if (category != null && !category.isBlank()) {
            sql.append(" AND CATEGORY=?");
            args.add(category.toUpperCase(Locale.ROOT));
        }
        if (code != null && !code.isBlank()) {
            sql.append(" AND RULE_CODE=?");
            args.add(code.toUpperCase(Locale.ROOT));
        }
        sql.append(" ORDER BY RULE_CODE, DECODE(SCOPE_TYPE,'GLOBAL',1,'DB_TYPE',2,'BIZ_TYPE',3,'INSTANCE',4,5), SCOPE_VALUE");
        return db.query(sql.toString(), args);
    }

    /** 新增/修改一条覆盖（同一 code+scope 存在即更新） */
    public void save(Map<String, Object> b, String username) {
        String code = Values.str(b.get("ruleCode"), "").toUpperCase(Locale.ROOT);
        String scopeType = Values.str(b.get("scopeType"), "GLOBAL").toUpperCase(Locale.ROOT);
        String scopeValue = "GLOBAL".equals(scopeType) ? "*" : Values.str(b.get("scopeValue"), "").trim();
        if (!code.matches("[PSDH]-\\d{3}")) {
            throw BizException.badRequest("规则编码不合法");
        }
        if (!SCOPES.contains(scopeType) || scopeValue.isEmpty()) {
            throw BizException.badRequest("作用域不合法");
        }
        Object params = b.get("params");
        String paramsJson = params == null ? null : params instanceof String s ? s : Json.write(params);
        if (paramsJson != null && !(Json.any(paramsJson) instanceof Map)) {
            throw BizException.badRequest("参数必须是 JSON 对象");
        }
        Map<String, Object> global = db.one("SELECT RULE_NAME, CATEGORY FROM DI_SQL_RULE WHERE RULE_CODE=? AND SCOPE_TYPE='GLOBAL'", code);
        if (global == null) {
            throw BizException.notFound("规则不存在: " + code);
        }
        Integer enabled = b.containsKey("enabled") ? (Values.truthy(b.get("enabled")) ? 1 : 0) : null;
        String severity = Values.str(b.get("severity"));
        int n = db.update("UPDATE DI_SQL_RULE SET ENABLED=NVL(?, ENABLED), SEVERITY=NVL(?, SEVERITY), PARAMS=NVL(?, PARAMS), "
                + "UPDATED_BY=?, UPDATED_AT=SYSTIMESTAMP WHERE RULE_CODE=? AND SCOPE_TYPE=? AND SCOPE_VALUE=?",
                enabled, severity, paramsJson, username, code, scopeType, scopeValue);
        if (n == 0) {
            db.update("INSERT INTO DI_SQL_RULE (RULE_CODE, RULE_NAME, CATEGORY, SCOPE_TYPE, SCOPE_VALUE, ENABLED, SEVERITY, PARAMS, DESCRIPTION, UPDATED_BY) "
                            + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", code, global.get("RULE_NAME"), global.get("CATEGORY"), scopeType, scopeValue,
                    enabled, severity, paramsJson, scopeType + " 覆盖", username);
        }
        reload();
    }

    public void delete(long ruleId) {
        Map<String, Object> r = db.one("SELECT SCOPE_TYPE FROM DI_SQL_RULE WHERE RULE_ID=?", ruleId);
        if (r == null) {
            throw BizException.notFound("规则不存在");
        }
        if ("GLOBAL".equals(r.get("SCOPE_TYPE"))) {
            throw BizException.badRequest("全局规则不能删除，可设置为停用");
        }
        db.update("DELETE FROM DI_SQL_RULE WHERE RULE_ID=?", ruleId);
        reload();
    }
}
