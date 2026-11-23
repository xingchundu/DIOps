package com.dbops.sqlinsight.collect;

import com.dbops.common.BizException;
import com.dbops.common.Db;
import com.dbops.common.Values;
import com.dbops.monitor.TargetConnector;
import com.dbops.monitor.TargetDb;
import com.dbops.service.SystemConfigService;
import com.dbops.sqlinsight.store.AssetService;
import com.dbops.sqlinsight.store.InstanceDirectory;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.sql.Timestamp;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 慢 SQL 快照：采集 → 按采集时间整批写入 SQL_SLOW_SUMMARY → 按时间范围查询 / 同一 SQL 的历次快照趋势。
 * <p>
 * 每批共用同一个 CAPTURE_TIME 与 CAPTURE_BATCH；每行关联 SQL 资产（ASSET_ID），在 SQL 洞察里可看到同一条 SQL 的运行时问题与波动。
 * 口径：源库统计视图中“截至采集时刻”的累计值（平均耗时 = 累计耗时 / 累计执行次数），不是区间增量；区间增量看 SQL 洞察的分钟统计。
 */
@Service
public class SlowSqlService {

    private static final Logger log = LoggerFactory.getLogger(SlowSqlService.class);

    private static final String INSERT = "INSERT INTO SQL_SLOW_SUMMARY (INSTANCE_ID, SQL_TEXT, SQL_HASH, DB_TYPE, AVG_ELAPSED, MAX_ELAPSED, EXEC_COUNT, "
            + "TOTAL_ELAPSED, FULL_SCAN, CAPTURE_TIME, PLAN_HASH, CAPTURE_BATCH, CAPTURE_SOURCE, SCHEMA_NAME, NATIVE_SQL_ID, ASSET_ID, "
            + "CPU_TIME_MS, LOGICAL_READS, PHYSICAL_READS, ROWS_PROCESSED, LAST_ACTIVE_TIME, STAT_SOURCE) "
            + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

    private final Db db;
    private final TargetConnector connector;
    private final InstanceDirectory instances;
    private final AssetService assets;
    private final SystemConfigService cfg;
    private final Set<Long> running = ConcurrentHashMap.newKeySet();

    public SlowSqlService(Db db, TargetConnector connector, InstanceDirectory instances, AssetService assets, SystemConfigService cfg) {
        this.db = db;
        this.connector = connector;
        this.instances = instances;
        this.assets = assets;
        this.cfg = cfg;
    }

    /**
     * 采集一次。
     * @param source MANUAL（页面“立即采集”）/ SCHEDULE（定时）/ FAULT（故障自愈）
     */
    public Map<String, Object> capture(long instanceId, String source, Double minAvgMsOverride) {
        InstanceDirectory.Inst inst = instances.get(instanceId);
        if (inst == null) {
            throw BizException.notFound("实例不存在");
        }
        if (!running.add(instanceId)) {
            throw BizException.badRequest("该实例的慢 SQL 采集正在进行，请稍后");
        }
        long t0 = System.currentTimeMillis();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("instanceId", instanceId);
        out.put("instanceName", inst.name());
        out.put("dbType", inst.dbType());
        try (TargetDb tdb = connector.open(instanceId)) {
            int topN = (int) Math.max(1, Math.min(500, cfg.getLong("sqlinsight.slow.top_n", 50)));
            double minAvg = minAvgMsOverride != null && minAvgMsOverride >= 0 ? minAvgMsOverride : cfg.getNumber("sqlinsight.slow.min_avg_ms", 1000);
            SlowSqlSource.Result res = SlowSqlSource.capture(tdb, inst.dbType(), topN, minAvg,
                    cfg.getNumber("sqlinsight.panwei.time_divisor", 1000), cfg.getNumber("sqlinsight.dameng.time_divisor", 1));
            Timestamp now = new Timestamp(System.currentTimeMillis() / 1000 * 1000);
            String batch = instanceId + "-" + new SimpleDateFormat("yyyyMMddHHmmss").format(now);
            List<Object[]> rows = new ArrayList<>();
            for (SlowSqlSource.SlowRow r : res.rows()) {
                Long assetId = null;
                String hash = null;
                try {
                    AssetService.AssetRef a = assets.resolveNative(instanceId, r.nativeId(), inst.dbType(), r.schema(), r.sqlText());
                    assetId = a.assetId();
                    hash = a.fingerprint();
                } catch (Exception e) {
                    log.debug("[slow-sql] asset resolve failed: {}", e.getMessage());
                }
                rows.add(new Object[]{instanceId, Values.truncate(r.sqlText(), 32000), hash, inst.dbType(), n(r.avgMs()), n(r.maxMs()), n(r.execs()),
                        n(r.totalMs()), r.fullScan() ? 1 : 0, now, Values.truncate(r.planHash(), 64), batch, source,
                        Values.truncate(r.schema(), 128), r.nativeId(), assetId, n(r.cpuMs()), n(r.logicalReads()), n(r.physicalReads()),
                        n(r.rows()), r.lastActive(), res.source()});
            }
            if (!rows.isEmpty()) {
                db.jdbc().batchUpdate(INSERT, rows);
            }
            out.put("count", rows.size());
            out.put("batch", batch);
            out.put("captureTime", now);
            out.put("source", res.source());
            out.put("minAvgMs", minAvg);
            out.put("topN", topN);
        } catch (BizException e) {
            throw e;
        } catch (Exception e) {
            if (Db.isMissingColumn(e) || Db.isMissingTable(e)) {
                throw new BizException(500, "SQL_SLOW_SUMMARY 表结构未升级：请执行 backend/sql/migration_sql_insight.sql");
            }
            out.put("count", 0);
            out.put("error", Values.truncate(e.getMessage(), 500));
            log.warn("[slow-sql] capture inst={} failed: {}", instanceId, e.getMessage());
        } finally {
            running.remove(instanceId);
        }
        out.put("costMs", System.currentTimeMillis() - t0);
        return out;
    }

    private static Object n(Double v) {
        return v == null || v.isNaN() || v.isInfinite() ? null : Values.round(v, 3);
    }

    // ------------------------------------------------------------------ 查询

    public Map<String, Object> list(Long instanceId, Timestamp from, Timestamp to, String keyword, Double minAvgMs, String batch,
                                    Long assetId, String page, String size) {
        List<String> where = new ArrayList<>();
        List<Object> args = new ArrayList<>();
        if (batch != null && !batch.isBlank()) {
            where.add("s.CAPTURE_BATCH = ?");
            args.add(batch);
        } else {
            where.add("s.CAPTURE_TIME BETWEEN ? AND ?");
            args.add(from);
            args.add(to);
        }
        if (instanceId != null) {
            where.add("s.INSTANCE_ID = ?");
            args.add(instanceId);
        }
        if (assetId != null) {
            where.add("s.ASSET_ID = ?");
            args.add(assetId);
        }
        if (minAvgMs != null) {
            where.add("s.AVG_ELAPSED >= ?");
            args.add(minAvgMs);
        }
        if (keyword != null && !keyword.isBlank()) {
            // LOWER(CLOB) 对每行生成临时 LOB（大表上又慢又占临时表空间）；改为在前 4000 字符内不区分大小写匹配
            where.add("(INSTR(LOWER(DBMS_LOB.SUBSTR(s.SQL_TEXT, 4000, 1)), ?) > 0 OR s.NATIVE_SQL_ID = ? OR s.SQL_HASH = ?)");
            args.add(Values.truncate(keyword.trim().toLowerCase(java.util.Locale.ROOT), 200));
            args.add(keyword.trim());
            args.add(keyword.trim());
        }
        String sql = "SELECT s.SQL_ID AS ROW_ID, s.INSTANCE_ID, i.INSTANCE_NAME, s.DB_TYPE, s.SCHEMA_NAME, s.NATIVE_SQL_ID, s.ASSET_ID, s.SQL_HASH, "
                + "DBMS_LOB.SUBSTR(s.SQL_TEXT, 2000, 1) AS SQL_TEXT, s.AVG_ELAPSED, s.MAX_ELAPSED, s.EXEC_COUNT, s.TOTAL_ELAPSED, s.CPU_TIME_MS, "
                + "s.LOGICAL_READS, s.PHYSICAL_READS, s.ROWS_PROCESSED, s.FULL_SCAN, s.PLAN_HASH, s.CAPTURE_TIME, s.CAPTURE_BATCH, "
                + "s.CAPTURE_SOURCE, s.LAST_ACTIVE_TIME, s.STAT_SOURCE, a.STATIC_RISK "
                + "FROM SQL_SLOW_SUMMARY s LEFT JOIN CMDB_INSTANCE i ON i.INSTANCE_ID = s.INSTANCE_ID LEFT JOIN DI_SQL_ASSET a ON a.ASSET_ID = s.ASSET_ID "
                + "WHERE " + String.join(" AND ", where) + " ORDER BY s.CAPTURE_TIME DESC, s.AVG_ELAPSED DESC NULLS LAST";
        return db.queryPage(sql, args, page, size);
    }

    /** 采集批次（时间轴） */
    public List<Map<String, Object>> batches(Long instanceId, Timestamp from, Timestamp to) {
        List<Object> args = new ArrayList<>(List.of(from, to));
        String w = "";
        if (instanceId != null) {
            w = " AND s.INSTANCE_ID = ?";
            args.add(instanceId);
        }
        return db.query("SELECT s.CAPTURE_BATCH, s.INSTANCE_ID, MAX(i.INSTANCE_NAME) INSTANCE_NAME, MAX(s.CAPTURE_TIME) CAPTURE_TIME, "
                + "MAX(s.CAPTURE_SOURCE) CAPTURE_SOURCE, MAX(s.STAT_SOURCE) STAT_SOURCE, COUNT(*) SQL_COUNT, MAX(s.AVG_ELAPSED) MAX_AVG_ELAPSED "
                + "FROM SQL_SLOW_SUMMARY s LEFT JOIN CMDB_INSTANCE i ON i.INSTANCE_ID = s.INSTANCE_ID "
                + "WHERE s.CAPTURE_TIME BETWEEN ? AND ? AND s.CAPTURE_BATCH IS NOT NULL" + w
                + " GROUP BY s.CAPTURE_BATCH, s.INSTANCE_ID ORDER BY CAPTURE_TIME DESC FETCH FIRST 200 ROWS ONLY", args);
    }

    /** 同一条 SQL（同资产 / 同原生 ID）在该实例历次快照中的指标，用于看变化趋势 */
    public List<Map<String, Object>> history(long rowId, int days) {
        Map<String, Object> r = db.one("SELECT INSTANCE_ID, ASSET_ID, NATIVE_SQL_ID FROM SQL_SLOW_SUMMARY WHERE SQL_ID=?", rowId);
        if (r == null) {
            throw BizException.notFound("记录不存在");
        }
        Timestamp since = new Timestamp(System.currentTimeMillis() - Math.max(1, Math.min(days, 90)) * 86400_000L);
        if (r.get("ASSET_ID") != null) {
            return db.query("SELECT SQL_ID AS ROW_ID, CAPTURE_TIME, AVG_ELAPSED, MAX_ELAPSED, EXEC_COUNT, TOTAL_ELAPSED, PLAN_HASH, FULL_SCAN "
                    + "FROM SQL_SLOW_SUMMARY WHERE INSTANCE_ID=? AND ASSET_ID=? AND CAPTURE_TIME >= ? ORDER BY CAPTURE_TIME", r.get("INSTANCE_ID"),
                    r.get("ASSET_ID"), since);
        }
        return db.query("SELECT SQL_ID AS ROW_ID, CAPTURE_TIME, AVG_ELAPSED, MAX_ELAPSED, EXEC_COUNT, TOTAL_ELAPSED, PLAN_HASH, FULL_SCAN "
                + "FROM SQL_SLOW_SUMMARY WHERE INSTANCE_ID=? AND NATIVE_SQL_ID=? AND CAPTURE_TIME >= ? ORDER BY CAPTURE_TIME", r.get("INSTANCE_ID"),
                r.get("NATIVE_SQL_ID"), since);
    }

    public Map<String, Object> row(long rowId) {
        Map<String, Object> r = db.one("SELECT s.*, i.INSTANCE_NAME FROM SQL_SLOW_SUMMARY s LEFT JOIN CMDB_INSTANCE i ON i.INSTANCE_ID = s.INSTANCE_ID "
                + "WHERE s.SQL_ID=?", rowId);
        if (r == null) {
            throw BizException.notFound("记录不存在");
        }
        return r;
    }

    /** 过期快照清理（分批） */
    public int purge(int keepDays) {
        int total = 0;
        for (int i = 0; i < 100; i++) {
            int n = db.update("DELETE FROM SQL_SLOW_SUMMARY WHERE CAPTURE_TIME < SYSTIMESTAMP - NUMTODSINTERVAL(?, 'DAY') AND ROWNUM <= 10000", keepDays);
            total += n;
            if (n < 10000) {
                break;
            }
        }
        return total;
    }

    public boolean isRunning(long instanceId) {
        return running.contains(instanceId);
    }
}
