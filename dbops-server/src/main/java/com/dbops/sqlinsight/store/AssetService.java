package com.dbops.sqlinsight.store;

import com.dbops.common.Db;
import com.dbops.common.Values;
import com.dbops.sqlinsight.ast.Finding;
import com.dbops.sqlinsight.ast.SqlAstService;
import com.dbops.sqlinsight.ast.StaticRuleEngine;
import com.dbops.sqlinsight.rules.RuleConfigService;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * SQL 资产（DI_SQL_ASSET / DI_SQL_ASSET_SOURCE）：全平台唯一的 SQL 标识。
 * 采集、审核、工单、AI 优化记录都通过 ASSET_ID 关联，替代原来三套互不相认的 hash。
 */
@Service
public class AssetService {

    public record AssetRef(long assetId, boolean core, String bizType, String fingerprint, boolean created) {
    }

    private static final int CACHE_MAX = 200_000;

    private final Db db;
    private final SqlAstService ast;
    private final RuleConfigService rules;
    /** 方言族|schema|指纹 → 资产 */
    private final Map<String, AssetRef> byFingerprint = lru(CACHE_MAX);
    /** 实例|原生ID → 资产（避免每分钟重复解析同一 SQL） */
    private final Map<String, AssetRef> byNative = lru(CACHE_MAX);
    /** 已写入 DI_SQL_ASSET_SOURCE 的组合 → 上次写入时间 */
    private final Map<String, Long> sourceTouched = lru(CACHE_MAX);
    private final Map<Long, Long> lastSeenTouched = lru(CACHE_MAX);

    public AssetService(Db db, SqlAstService ast, RuleConfigService rules) {
        this.db = db;
        this.ast = ast;
        this.rules = rules;
    }

    private static <K, V> Map<K, V> lru(int max) {
        return java.util.Collections.synchronizedMap(new LinkedHashMap<>(1024, 0.75f, true) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<K, V> e) {
                return size() > max;
            }
        });
    }

    /** 采集链路：按实例+原生 ID 命中缓存，未命中才解析 */
    public AssetRef resolveNative(long instanceId, String nativeId, String platformType, String schema, String sqlText) {
        String nk = instanceId + "|" + nativeId;
        AssetRef r = byNative.get(nk);
        if (r != null) {
            return r;
        }
        r = resolve(ast.analyze(sqlText, platformType, schema), sqlText);
        byNative.put(nk, r);
        return r;
    }

    public AssetRef resolve(SqlAstService.SqlAnalysis a, String sample) {
        String key = a.dbFamily() + "|" + a.schema() + "|" + a.fingerprint();
        AssetRef r = byFingerprint.get(key);
        if (r != null) {
            return r;
        }
        Map<String, Object> row = db.one("SELECT ASSET_ID, IS_CORE, BIZ_TYPE FROM DI_SQL_ASSET WHERE DB_TYPE=? AND SCHEMA_NAME=? AND FINGERPRINT=?",
                a.dbFamily(), a.schema(), a.fingerprint());
        boolean created = false;
        if (row == null) {
            try {
                db.update("INSERT INTO DI_SQL_ASSET (DB_TYPE, SCHEMA_NAME, FINGERPRINT, NORMALIZED_SQL, SAMPLE_SQL, STMT_TYPE, TABLES, PARSE_STATUS) "
                                + "VALUES (?, ?, ?, ?, ?, ?, ?, ?)", a.dbFamily(), a.schema(), a.fingerprint(), a.normalized(),
                        Values.truncate(sample, 32000), a.stmtType(), Values.truncate(String.join(",", a.tables()), 2000),
                        a.parsed() ? "PARSED" : "FALLBACK");
                created = true;
            } catch (Exception e) {
                if (!Db.isUniqueViolation(e)) {
                    throw e;
                }
            }
            row = db.one("SELECT ASSET_ID, IS_CORE, BIZ_TYPE FROM DI_SQL_ASSET WHERE DB_TYPE=? AND SCHEMA_NAME=? AND FINGERPRINT=?",
                    a.dbFamily(), a.schema(), a.fingerprint());
        }
        r = new AssetRef(Values.toLong(row.get("ASSET_ID"), 0), Values.toInt(row.get("IS_CORE"), 0) == 1,
                Values.str(row.get("BIZ_TYPE")), a.fingerprint(), created);
        if (created) {
            analyzeStatic(r.assetId(), a);
        }
        byFingerprint.put(key, r);
        return r;
    }

    /** 新资产落库时做一次静态分析（无实例元数据；S-005/S-006 需元数据的部分在审核时补充） */
    public StaticRuleEngine.Result analyzeStatic(long assetId, SqlAstService.SqlAnalysis a) {
        StaticRuleEngine.Result res = StaticRuleEngine.analyze(a,
                rules.staticView(new RuleConfigService.Scope(assetId, null, null, a.dbFamily())), null);
        List<Map<String, Object>> findings = new ArrayList<>();
        String risk = "NONE";
        for (Finding f : res.findings()) {
            findings.add(f.toMap());
            risk = maxSeverity(risk, f.severity());
        }
        String status = a.parsed() ? "ANALYZED" : "UNANALYZED";
        db.updateQuietly("UPDATE DI_SQL_ASSET SET STATIC_STATUS=?, STATIC_RESULT=?, STATIC_RISK=? WHERE ASSET_ID=?",
                status, Json.write(Map.of("findings", findings, "skipped", res.skipped().stream().map(Finding.Skipped::toMap).toList())),
                risk, assetId);
        return res;
    }

    public static String maxSeverity(String a, String b) {
        return rank(b) > rank(a) ? b : a;
    }

    public static int rank(String s) {
        if (s == null) {
            return 0;
        }
        return switch (s.toUpperCase()) {
            case "CRITICAL" -> 4;
            case "ERROR" -> 3;
            case "WARNING", "WARN" -> 2;
            case "INFO" -> 1;
            default -> 0;
        };
    }

    /** 批量登记原生标识（30 分钟内同一组合只写一次） */
    public void touchSources(long instanceId, Map<Long, List<String>> nativeIds) {
        long now = System.currentTimeMillis();
        List<Object[]> batch = new ArrayList<>();
        for (Map.Entry<Long, List<String>> e : nativeIds.entrySet()) {
            for (String nid : e.getValue()) {
                String k = e.getKey() + "|" + instanceId + "|" + nid;
                Long t = sourceTouched.get(k);
                if (t == null || now - t > 1800_000L) {
                    batch.add(new Object[]{e.getKey(), instanceId, nid});
                    sourceTouched.put(k, now);
                }
            }
        }
        if (!batch.isEmpty()) {
            db.jdbc().batchUpdate("MERGE INTO DI_SQL_ASSET_SOURCE t USING (SELECT ? AS A, ? AS I, ? AS N FROM DUAL) s "
                    + "ON (t.ASSET_ID = s.A AND t.INSTANCE_ID = s.I AND t.NATIVE_ID = s.N) "
                    + "WHEN MATCHED THEN UPDATE SET LAST_SEEN = SYSTIMESTAMP "
                    + "WHEN NOT MATCHED THEN INSERT (ASSET_ID, INSTANCE_ID, NATIVE_ID) VALUES (s.A, s.I, s.N)", batch);
        }
    }

    /** 资产 LAST_SEEN（10 分钟内只写一次） */
    public void touchLastSeen(Collection<Long> assetIds) {
        long now = System.currentTimeMillis();
        List<Object[]> batch = new ArrayList<>();
        for (Long id : assetIds) {
            Long t = lastSeenTouched.get(id);
            if (t == null || now - t > 600_000L) {
                batch.add(new Object[]{id});
                lastSeenTouched.put(id, now);
            }
        }
        if (!batch.isEmpty()) {
            db.jdbc().batchUpdate("UPDATE DI_SQL_ASSET SET LAST_SEEN = SYSTIMESTAMP WHERE ASSET_ID = ?", batch);
        }
    }

    /** 人工修改核心标记/业务类型后清缓存 */
    public void invalidate() {
        byFingerprint.clear();
        byNative.clear();
    }
}
