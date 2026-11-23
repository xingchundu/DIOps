package com.dbops.sqlinsight.audit;

import com.dbops.common.Values;
import com.dbops.monitor.TargetDb;
import com.dbops.sqlinsight.ast.SqlAstService;
import com.dbops.sqlinsight.ast.TableMetadata;
import com.dbops.sqlinsight.optimize.IndexAdvisor;
import com.dbops.sqlinsight.optimize.PlanAnalyzer;
import com.dbops.sqlinsight.optimize.RewriteEngine;
import com.dbops.sqlinsight.store.InstanceDirectory;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 规则优先的 SQL 优化（不依赖大模型，结果可复现）：
 * <pre>
 * 统一审核（静态规则 + 实例检查 + 执行计划） → 执行计划分析 → 索引建议 → 规则改写（可等价改写的直接生成新 SQL）
 *   → 改写后执行计划对比 → 运行时证据（SQL 洞察的问题/波动/近 24 小时统计） → 按优先级排列的处理建议
 * </pre>
 * AI 优化 Agent 把这里的结果作为上下文再做深度改写；大模型的输出另由 sql_validator 校验，规则结果不受大模型影响。
 */
@Service
public class SqlOptimizeService {

    private final SqlAstService ast;
    private final SqlAuditService audit;
    private final ExplainService explain;
    private final InstanceDirectory instances;

    public SqlOptimizeService(SqlAstService ast, SqlAuditService audit, ExplainService explain, InstanceDirectory instances) {
        this.ast = ast;
        this.audit = audit;
        this.explain = explain;
        this.instances = instances;
    }

    public Map<String, Object> optimize(String sql, String dbType, String schema, Long instanceId) {
        InstanceDirectory.Inst inst = instanceId == null ? null : instances.get(instanceId);
        String platform = inst != null ? inst.dbType() : dbType;
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("engine", "rule");
        Map<String, Object> au = audit.audit(new SqlAuditService.Request(sql, platform, schema, instanceId, inst != null, true));
        out.put("audit", au);
        out.put("score", au.get("score"));
        out.put("risk", au.get("risk"));
        out.put("dbType", au.get("dbType"));
        out.put("stmtType", au.get("stmtType"));
        out.put("assetId", au.get("assetId"));
        out.put("runtime", au.get("runtime"));
        out.put("instanceId", instanceId);

        SqlAstService.SqlAnalysis a = ast.analyze(sql, platform, schema);
        String plan = null;
        if (au.get("instanceCheck") instanceof Map<?, ?> ic && Boolean.TRUE.equals(ic.get("explainOk"))) {
            plan = Values.str(ic.get("explainPlan"));
        }
        Set<String> fullScan = PlanAnalyzer.fullScanTables(plan, platform);
        Map<String, Object> planMap = new LinkedHashMap<>();
        planMap.put("text", plan);
        planMap.put("fullScanTables", fullScan);
        planMap.put("findings", PlanAnalyzer.analyze(plan, platform));
        planMap.put("cost", PlanAnalyzer.cost(plan, platform));
        out.put("plan", planMap);

        List<IndexAdvisor.IndexAdvice> idx;
        RewriteEngine.Result rw;
        Map<String, Object> after = null;
        if (inst != null && a.parsed()) {
            Object[] holder = new Object[3];
            try {
                final String planBefore = plan;
                explain.withConnection(inst.id(), tdb -> {
                    TargetMetadata md = new TargetMetadata(tdb, inst.dbType());
                    holder[0] = IndexAdvisor.advise(a, md, fullScan, inst.dbType());
                    RewriteEngine.Result r = RewriteEngine.rewrite(sql, a.dialect(), inst.dbType(), md);
                    holder[1] = r;
                    if (r.rewrittenSql() != null && planBefore != null) {
                        holder[2] = planOf(tdb, inst.dbType(), r.rewrittenSql());
                    }
                    return null;
                });
            } catch (Exception e) {
                out.put("metadataError", Values.truncate(e.getMessage(), 300));
            }
            @SuppressWarnings("unchecked")
            List<IndexAdvisor.IndexAdvice> h0 = (List<IndexAdvisor.IndexAdvice>) holder[0];
            idx = h0 != null ? h0 : IndexAdvisor.advise(a, TableMetadata.NONE, fullScan, platform);
            rw = holder[1] != null ? (RewriteEngine.Result) holder[1] : RewriteEngine.rewrite(sql, a.dialect(), platform, TableMetadata.NONE);
            @SuppressWarnings("unchecked")
            Map<String, Object> h2 = (Map<String, Object>) holder[2];
            after = h2;
        } else {
            idx = IndexAdvisor.advise(a, TableMetadata.NONE, fullScan, platform);
            rw = RewriteEngine.rewrite(sql, a.dialect(), platform, TableMetadata.NONE);
        }
        out.put("indexAdvice", idx);
        out.put("rewrites", rw.rewrites());
        out.put("rewrittenSql", rw.rewrittenSql());
        if (after != null) {
            out.put("rewrittenPlan", after);
        }
        out.put("actions", actions(au, planMap, idx, rw, after));
        return out;
    }

    private Map<String, Object> planOf(TargetDb tdb, String platform, String sql) {
        Map<String, Object> m = new LinkedHashMap<>();
        try {
            String p = explain.runExplain(tdb, platform, ExplainService.clean(sql));
            m.put("text", p);
            m.put("fullScanTables", PlanAnalyzer.fullScanTables(p, platform));
            m.put("cost", PlanAnalyzer.cost(p, platform));
        } catch (Exception e) {
            m.put("error", Values.truncate(e.getMessage(), 300));
        }
        return m;
    }

    /** 按优先级给出处理建议：阻断问题 → 全表扫描的索引 → 可直接采用的改写 → 其它建议 */
    static List<Map<String, Object>> actions(Map<String, Object> au, Map<String, Object> plan, List<IndexAdvisor.IndexAdvice> idx,
                                             RewriteEngine.Result rw, Map<String, Object> after) {
        List<Map<String, Object>> out = new ArrayList<>();
        if (au.get("issues") instanceof List<?> issues) {
            for (Object o : issues) {
                if (o instanceof Map<?, ?> i) {
                    String sev = Values.str(i.get("severity"), "");
                    if ("CRITICAL".equals(sev) || "ERROR".equals(sev)) {
                        out.add(action(1, "FIX", Values.str(i.get("message"), "") + (i.get("suggestion") != null ? "；" + i.get("suggestion") : "")));
                    }
                }
            }
        }
        for (IndexAdvisor.IndexAdvice x : idx) {
            if (x.ddl() != null && !"LOW".equals(x.confidence())) {
                out.add(action("HIGH".equals(x.confidence()) ? 2 : 3, "INDEX", "为 " + x.table() + " 建索引 (" + String.join(", ", x.columns()) + ")：" + x.ddl()));
            } else if (x.ddl() == null) {
                out.add(action(2, "FILTER", x.table() + "：" + x.reason()));
            }
        }
        boolean appliedAny = rw.rewrites().stream().anyMatch(RewriteEngine.Rewrite::applied);
        if (appliedAny) {
            String gain = "";
            if (after != null && plan.get("cost") instanceof Double c0 && after.get("cost") instanceof Double c1 && c0 > 0) {
                gain = String.format("（估算代价 %.0f → %.0f）", c0, c1);
            }
            out.add(action(3, "REWRITE", "采用“规则改写后 SQL”" + gain + "，并在测试环境验证结果一致"));
        }
        for (RewriteEngine.Rewrite r : rw.rewrites()) {
            if (!r.applied()) {
                out.add(action(4, "SUGGEST", r.title() + "：" + r.suggestion()));
            }
        }
        if (plan.get("findings") instanceof List<?> fs) {
            for (Object o : fs) {
                if (o instanceof PlanAnalyzer.PlanFinding f && !"X-001".equals(f.code())) {
                    out.add(action("CRITICAL".equals(f.severity()) ? 1 : 4, "PLAN", f.title() + "：" + f.detail()));
                }
            }
        }
        out.sort((x, y) -> Integer.compare((int) x.get("priority"), (int) y.get("priority")));
        return out;
    }

    private static Map<String, Object> action(int priority, String type, String text) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("priority", priority);
        m.put("type", type);
        m.put("text", text);
        return m;
    }
}
