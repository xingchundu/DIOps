package com.dbops.sqlinsight.plan;

import com.dbops.common.Db;
import com.dbops.common.Values;
import com.dbops.monitor.CmdbInstance;
import com.dbops.monitor.DbType;
import com.dbops.monitor.TargetConnector;
import com.dbops.monitor.TargetDb;
import com.dbops.sqlinsight.audit.ExplainService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * 执行计划文本获取与留存（DI_SQL_PLAN_TEXT）。
 * Oracle：按 sql_id + plan_hash_value 从共享池（V$SQL → DBMS_XPLAN.DISPLAY_CURSOR）取历史计划，已被挤出则回退 AWR（DISPLAY_AWR，需 Diagnostics Pack 许可，失败忽略）。
 * 其他库没有稳定的 plan hash，取「当前」EXPLAIN（不带 ANALYZE，不执行 SQL），以 EXPLAIN@时间戳 为键留存，复测前后各取一次对比。
 * 只做只读查询；任何失败返回 null，由调用方降级提示。
 */
@Service
public class PlanCaptureService {

    private static final Logger log = LoggerFactory.getLogger(PlanCaptureService.class);
    private static final Pattern ORA_SQL_ID = Pattern.compile("[0-9a-z]{13}");
    private static final DateTimeFormatter TS = DateTimeFormatter.ofPattern("yyyyMMddHHmmss");

    private final Db db;
    private final TargetConnector connector;
    private final ExplainService explain;

    public PlanCaptureService(Db db, TargetConnector connector, ExplainService explain) {
        this.db = db;
        this.connector = connector;
        this.explain = explain;
    }

    public static final class Plan {
        public final String hash;
        public final String text;
        public final String source;

        Plan(String hash, String text, String source) {
            this.hash = hash;
            this.text = text;
            this.source = source;
        }
    }

    /** 已留存的计划 */
    public Plan stored(long instanceId, long assetId, String planHash) {
        if (planHash == null) {
            return null;
        }
        Map<String, Object> r = db.one("SELECT DBMS_LOB.SUBSTR(PLAN_TEXT, 32000, 1) T, SOURCE FROM DI_SQL_PLAN_TEXT WHERE INSTANCE_ID=? AND ASSET_ID=? AND PLAN_HASH=?",
                instanceId, assetId, planHash);
        return r == null ? null : new Plan(planHash, Values.str(r.get("T")), Values.str(r.get("SOURCE")));
    }

    /**
     * 取计划：先查留存；Oracle 且有 plan hash 时从共享池/AWR 取历史计划；否则对资产样本 SQL 做 EXPLAIN。
     * @param planHash 可为空或 'NA'（表示取当前计划）
     */
    public Plan capture(long instanceId, long assetId, String planHash) {
        boolean hasHash = planHash != null && !planHash.isBlank() && !"NA".equalsIgnoreCase(planHash);
        if (hasHash) {
            Plan s = stored(instanceId, assetId, planHash);
            if (s != null && s.text != null) {
                return s;
            }
        }
        try {
            CmdbInstance inst = connector.fetch(instanceId);
            String type = DbType.normalize(inst.dbType());
            if (hasHash && DbType.ORACLE.equals(type)) {
                Plan p = oracleHistorical(instanceId, assetId, planHash);
                if (p != null) {
                    save(instanceId, assetId, p);
                    return p;
                }
            }
            if (hasHash) {
                // 历史计划取不到：不能拿“现在的计划”冒充当时的
                return null;
            }
            Map<String, Object> a = db.one("SELECT DBMS_LOB.SUBSTR(SAMPLE_SQL, 32000, 1) SQL_TEXT FROM DI_SQL_ASSET WHERE ASSET_ID=?", assetId);
            String sql = a == null ? null : Values.str(a.get("SQL_TEXT"));
            if (sql == null || sql.isBlank()) {
                return null;
            }
            Map<String, Object> ex = explain.explain(instanceId, sql);
            String text = Values.str(ex.get("plan"));
            if (text == null || text.isBlank()) {
                return null;
            }
            Plan p = new Plan("EXPLAIN@" + LocalDateTime.now().format(TS), text, "EXPLAIN");
            save(instanceId, assetId, p);
            return p;
        } catch (Exception e) {
            log.debug("[sqlinsight] plan capture inst={} asset={}: {}", instanceId, assetId, e.getMessage());
            return null;
        }
    }

    private Plan oracleHistorical(long instanceId, long assetId, String planHash) throws Exception {
        Map<String, Object> n = db.one("SELECT MAX(NATIVE_ID) KEEP (DENSE_RANK LAST ORDER BY LAST_SEEN) NID FROM DI_SQL_ASSET_SOURCE WHERE ASSET_ID=? AND INSTANCE_ID=?",
                assetId, instanceId);
        String sqlId = n == null ? null : Values.str(n.get("NID"));
        if (sqlId == null || !ORA_SQL_ID.matcher(sqlId).matches() || !planHash.matches("\\d+")) {
            return null;
        }
        try (TargetDb t = connector.open(instanceId)) {
            Map<String, Object> child = t.oneQuietly("SELECT CHILD_NUMBER CN FROM V$SQL WHERE SQL_ID = ? AND PLAN_HASH_VALUE = ? AND ROWNUM = 1", sqlId, planHash);
            List<Map<String, Object>> rows = null;
            String source = "CURSOR";
            if (child != null) {
                rows = t.queryQuietly("SELECT PLAN_TABLE_OUTPUT P FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(?, ?, 'TYPICAL'))", sqlId, child.get("CN"));
            }
            if (rows == null || rows.size() < 5) {
                rows = t.queryQuietly("SELECT PLAN_TABLE_OUTPUT P FROM TABLE(DBMS_XPLAN.DISPLAY_AWR(?, ?, NULL, 'TYPICAL'))", sqlId, planHash);
                source = "AWR";
            }
            if (rows == null || rows.size() < 5) {
                return null;
            }
            StringBuilder sb = new StringBuilder();
            for (Map<String, Object> r : rows) {
                sb.append(Values.str(r.get("P"), "")).append('\n');
            }
            return new Plan(planHash, sb.toString(), source);
        }
    }

    private void save(long instanceId, long assetId, Plan p) {
        try {
            db.update("MERGE INTO DI_SQL_PLAN_TEXT t USING (SELECT ? I, ? A, ? H FROM DUAL) s ON (t.INSTANCE_ID = s.I AND t.ASSET_ID = s.A AND t.PLAN_HASH = s.H) "
                            + "WHEN MATCHED THEN UPDATE SET t.PLAN_TEXT = ?, t.SOURCE = ?, t.CAPTURED_AT = SYSTIMESTAMP "
                            + "WHEN NOT MATCHED THEN INSERT (INSTANCE_ID, ASSET_ID, PLAN_HASH, PLAN_TEXT, SOURCE) VALUES (s.I, s.A, s.H, ?, ?)",
                    instanceId, assetId, p.hash, Values.truncate(p.text, 32000), p.source, Values.truncate(p.text, 32000), p.source);
        } catch (Exception e) {
            log.debug("[sqlinsight] plan save: {}", e.getMessage());
        }
    }

    /** 对比两个计划（任意一个取不到时 parsed=false 并说明原因） */
    public Map<String, Object> compare(long instanceId, long assetId, String oldHash, String newHash) {
        Plan o = capture(instanceId, assetId, oldHash);
        Plan n = capture(instanceId, assetId, newHash);
        Map<String, Object> r = PlanDiff.compare(o == null ? null : o.text, n == null ? null : n.text);
        r.put("oldPlan", o == null ? null : o.text);
        r.put("newPlan", n == null ? null : n.text);
        r.put("oldSource", o == null ? null : o.source);
        r.put("newSource", n == null ? null : n.source);
        if (o == null || n == null) {
            r.put("summary", (o == null ? "旧计划（" + oldHash + "）" : "") + (o == null && n == null ? "、" : "") + (n == null ? "新计划（" + newHash + "）" : "")
                    + "已从共享池 / AWR 中清除或无权限读取，无法对比访问路径；可在计划变化页查看耗时与读量对比");
        }
        return r;
    }
}
