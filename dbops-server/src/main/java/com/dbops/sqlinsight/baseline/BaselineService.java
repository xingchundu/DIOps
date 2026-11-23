package com.dbops.sqlinsight.baseline;

import com.dbops.common.Db;
import com.dbops.common.Values;
import com.dbops.service.SystemConfigService;
import com.dbops.sqlinsight.collect.Metric;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.sql.Timestamp;
import java.time.DayOfWeek;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 基线（设计方案 5.2）：
 * <ul>
 *   <li>只为“重点 SQL”建基线：每实例按 DB Time 取前 N 条 + 人工标记的核心 SQL</li>
 *   <li>按 工作日/周末 × 24 小时 分时段，取最近 28 天（或最近一次基线锚点之后）的 NORMAL 窗口，排除变更窗口</li>
 *   <li>中位数 + MAD，在 Oracle 里用 MEDIAN 聚合算完，不把几十万行搬到应用里</li>
 *   <li>分时段样本不足 minSamples 时回退到最近 24 小时（R24）；仍不足则该指标不检测</li>
 * </ul>
 */
@Service
public class BaselineService {

    private static final Logger log = LoggerFactory.getLogger(BaselineService.class);
    public static final int MIN_SAMPLES_DEFAULT = 30;

    private final Db db;
    private final SystemConfigService cfg;
    /** instanceId → (slot → assetId → metric → baseline)，每小时随刷新重载 */
    private final Map<Long, Map<String, Map<Long, Map<Metric, Baseline>>>> cache = new ConcurrentHashMap<>();
    private final Map<Long, Long> cacheLoadedAt = new ConcurrentHashMap<>();

    public BaselineService(Db db, SystemConfigService cfg) {
        this.db = db;
        this.cfg = cfg;
    }

    public static String dayType(LocalDateTime t) {
        DayOfWeek d = t.getDayOfWeek();
        return d == DayOfWeek.SATURDAY || d == DayOfWeek.SUNDAY ? "WE" : "WD";
    }

    public int minSamples() {
        return (int) cfg.getLong("sqlinsight.baseline.min_samples", MIN_SAMPLES_DEFAULT);
    }

    // ------------------------------------------------------------------ 刷新

    /** 重点 SQL：最近 24 小时 DB Time 前 N + 核心 SQL */
    public List<Long> focusAssets(long instanceId) {
        int topN = (int) cfg.getLong("sqlinsight.baseline.focus_top_n", 200);
        List<Long> ids = new ArrayList<>();
        for (Map<String, Object> r : db.query("SELECT ASSET_ID FROM (SELECT ASSET_ID, SUM(D_ELAPSED_MS) T FROM DI_SQL_STATS_MIN "
                + "WHERE INSTANCE_ID=? AND WINDOW_START >= LOCALTIMESTAMP - INTERVAL '1' DAY GROUP BY ASSET_ID ORDER BY T DESC NULLS LAST) "
                + "WHERE ROWNUM <= ?", instanceId, topN)) {
            ids.add(Values.toLong(r.get("ASSET_ID"), 0));
        }
        for (Map<String, Object> r : db.query("SELECT DISTINCT s.ASSET_ID FROM DI_SQL_ASSET_SOURCE s JOIN DI_SQL_ASSET a ON a.ASSET_ID = s.ASSET_ID "
                + "WHERE s.INSTANCE_ID=? AND a.IS_CORE=1", instanceId)) {
            long id = Values.toLong(r.get("ASSET_ID"), 0);
            if (!ids.contains(id)) {
                ids.add(id);
            }
        }
        return ids;
    }

    /** 资产基线起点：28 天前与最近一次锚点取较晚者 */
    Timestamp since(long instanceId, long assetId, int days) {
        Map<String, Object> r = db.one("SELECT MAX(ANCHOR_TIME) AS T FROM DI_SQL_BASELINE_ANCHOR WHERE ASSET_ID=? AND (INSTANCE_ID=? OR INSTANCE_ID IS NULL)",
                assetId, instanceId);
        long from = System.currentTimeMillis() - days * 86400_000L;
        if (r != null && r.get("T") instanceof Timestamp t && t.getTime() > from) {
            from = t.getTime();
        }
        return new Timestamp(from);
    }

    public int refresh(long instanceId) {
        int days = (int) cfg.getLong("sqlinsight.baseline.days", 28);
        int n = 0;
        for (long asset : focusAssets(instanceId)) {
            try {
                n += refreshAsset(instanceId, asset, days);
            } catch (Exception e) {
                log.warn("[sqlinsight] baseline inst={} asset={}: {}", instanceId, asset, e.getMessage());
            }
        }
        cacheLoadedAt.remove(instanceId);
        return n;
    }

    static String slotQuery(boolean grouped) {
        StringBuilder inner = new StringBuilder();
        StringBuilder mid = new StringBuilder();
        StringBuilder outer = new StringBuilder();
        String part = grouped ? "PARTITION BY DT, HR" : "";
        for (Metric m : Metric.values()) {
            int i = m.ordinal();
            inner.append(", ").append(m.column);
            mid.append(", ").append(m.column).append(", MEDIAN(").append(m.column).append(") OVER (").append(part).append(") MD").append(i);
            outer.append(", COUNT(").append(m.column).append(") N").append(i)
                    .append(", MEDIAN(").append(m.column).append(") MED").append(i)
                    .append(", MEDIAN(ABS(").append(m.column).append(" - MD").append(i).append(")) MAD").append(i);
        }
        String dt = grouped ? "CASE WHEN TO_CHAR(WINDOW_START, 'DY', 'NLS_DATE_LANGUAGE=AMERICAN') IN ('SAT', 'SUN') THEN 'WE' ELSE 'WD' END"
                : "'R24'";
        String hr = grouped ? "TO_NUMBER(TO_CHAR(WINDOW_START, 'HH24'))" : "-1";
        return "SELECT DT, HR" + outer + " FROM (SELECT DT, HR" + mid + " FROM (SELECT " + dt + " DT, " + hr + " HR" + inner
                + " FROM DI_SQL_STATS_MIN WHERE ASSET_ID=? AND INSTANCE_ID=? AND WINDOW_START >= ? AND DATA_QUALITY='NORMAL' "
                + "AND NVL(EXCLUDE_BASELINE, 0) = 0)) GROUP BY DT, HR";
    }

    int refreshAsset(long instanceId, long assetId, int days) {
        Timestamp from = since(instanceId, assetId, days);
        Timestamp from24 = new Timestamp(Math.max(from.getTime(), System.currentTimeMillis() - 86400_000L));
        List<Map<String, Object>> rows = new ArrayList<>(db.query(slotQuery(true), assetId, instanceId, from));
        rows.addAll(db.query(slotQuery(false), assetId, instanceId, from24));
        List<Object[]> batch = new ArrayList<>();
        Timestamp now = new Timestamp(System.currentTimeMillis());
        for (Map<String, Object> r : rows) {
            for (Metric m : Metric.values()) {
                int i = m.ordinal();
                long cnt = Values.toLong(r.get("N" + i), 0);
                if (cnt == 0) {
                    continue;
                }
                batch.add(new Object[]{instanceId, assetId, m.key, r.get("DT"), Values.toInt(r.get("HR"), -1),
                        r.get("MED" + i), r.get("MAD" + i), cnt, "R24".equals(r.get("DT")) ? from24 : from, now});
            }
        }
        // 先清旧（锚点之后旧时段可能已无数据），再写新——放在同一事务里，批量插入失败时回滚，不会把基线清空
        db.inTx(() -> {
            db.update("DELETE FROM DI_SQL_BASELINE WHERE INSTANCE_ID=? AND ASSET_ID=?", instanceId, assetId);
            if (!batch.isEmpty()) {
                db.jdbc().batchUpdate("INSERT INTO DI_SQL_BASELINE (INSTANCE_ID, ASSET_ID, METRIC, DAY_TYPE, HOUR_OF_DAY, MEDIAN_VAL, MAD_VAL, "
                        + "SAMPLE_COUNT, WINDOW_FROM, WINDOW_TO) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", batch);
            }
        });
        return batch.size();
    }

    // ------------------------------------------------------------------ 查询

    /** 当前时段可用的基线：分时段样本足够用分时段，否则 R24，否则无 */
    public Map<Long, Map<Metric, Baseline>> current(long instanceId, LocalDateTime at) {
        String slot = dayType(at) + "-" + at.getHour();
        Long loaded = cacheLoadedAt.get(instanceId);
        Map<String, Map<Long, Map<Metric, Baseline>>> bySlot = cache.get(instanceId);
        if (loaded == null || bySlot == null || !bySlot.containsKey(slot) || System.currentTimeMillis() - loaded > 3600_000L) {
            bySlot = new HashMap<>();
            bySlot.put(slot, load(instanceId, dayType(at), at.getHour()));
            cache.put(instanceId, bySlot);
            cacheLoadedAt.put(instanceId, System.currentTimeMillis());
        }
        return bySlot.get(slot);
    }

    private Map<Long, Map<Metric, Baseline>> load(long instanceId, String dt, int hour) {
        int min = minSamples();
        Map<Long, Map<Metric, Baseline>> slotMap = new HashMap<>();
        Map<Long, Map<Metric, Baseline>> r24 = new HashMap<>();
        for (Map<String, Object> r : db.query("SELECT ASSET_ID, METRIC, DAY_TYPE, HOUR_OF_DAY, MEDIAN_VAL, MAD_VAL, SAMPLE_COUNT FROM DI_SQL_BASELINE "
                + "WHERE INSTANCE_ID=? AND ((DAY_TYPE=? AND HOUR_OF_DAY=?) OR DAY_TYPE='R24') AND SAMPLE_COUNT >= ?", instanceId, dt, hour, min)) {
            Metric m = Metric.byKey(Values.str(r.get("METRIC")));
            Double med = Values.toDouble(r.get("MEDIAN_VAL"));
            if (m == null || med == null) {
                continue;
            }
            boolean isR24 = "R24".equals(r.get("DAY_TYPE"));
            Baseline b = new Baseline(med, Values.toDouble(r.get("MAD_VAL")) == null ? 0 : Values.toDouble(r.get("MAD_VAL")),
                    Values.toLong(r.get("SAMPLE_COUNT"), 0), isR24 ? "R24" : dt + "-" + hour);
            (isR24 ? r24 : slotMap).computeIfAbsent(Values.toLong(r.get("ASSET_ID"), 0), k -> new EnumMap<>(Metric.class)).put(m, b);
        }
        for (Map.Entry<Long, Map<Metric, Baseline>> e : r24.entrySet()) {
            Map<Metric, Baseline> target = slotMap.computeIfAbsent(e.getKey(), k -> new EnumMap<>(Metric.class));
            e.getValue().forEach(target::putIfAbsent);
        }
        return slotMap;
    }

    public List<Map<String, Object>> list(long instanceId, long assetId) {
        return db.query("SELECT METRIC, DAY_TYPE, HOUR_OF_DAY, MEDIAN_VAL, MAD_VAL, SAMPLE_COUNT, WINDOW_FROM, REFRESHED_AT FROM DI_SQL_BASELINE "
                + "WHERE INSTANCE_ID=? AND ASSET_ID=? ORDER BY METRIC, DAY_TYPE, HOUR_OF_DAY", instanceId, assetId);
    }

    // ------------------------------------------------------------------ 锚点（接受新基线 / 优化完成 / 发布）

    public void anchor(Long instanceId, long assetId, String reason, String operator, String note) {
        db.update("INSERT INTO DI_SQL_BASELINE_ANCHOR (INSTANCE_ID, ASSET_ID, REASON, OPERATOR, NOTE) VALUES (?, ?, ?, ?, ?)",
                instanceId, assetId, Values.truncate(reason, 32), operator, Values.truncate(note, 512));
        if (instanceId == null) {
            db.update("DELETE FROM DI_SQL_BASELINE WHERE ASSET_ID=?", assetId);
            cacheLoadedAt.clear();
        } else {
            db.update("DELETE FROM DI_SQL_BASELINE WHERE ASSET_ID=? AND INSTANCE_ID=?", assetId, instanceId);
            cacheLoadedAt.remove(instanceId);
        }
    }

    // ------------------------------------------------------------------ 缓慢劣化（按天）

    public record Degradation(long assetId, Metric metric, double recent, double base, double ratio, List<Double> lastDays) {
    }

    static final List<Metric> DEGRADATION_METRICS = List.of(Metric.AVG_ELAPSED_MS, Metric.CPU_PER_EXEC_MS,
            Metric.LOGICAL_READS_PER_EXEC, Metric.ROWS_EXAMINED_PER_EXEC);

    public List<Degradation> slowDegradation(long instanceId, double ratio) {
        List<Degradation> out = new ArrayList<>();
        for (long asset : focusAssets(instanceId)) {
            Timestamp from = since(instanceId, asset, 28);
            StringBuilder cols = new StringBuilder();
            for (Metric m : DEGRADATION_METRICS) {
                cols.append(", MEDIAN(").append(m.column).append(") ").append(m.column);
            }
            List<Map<String, Object>> days = db.query("SELECT TRUNC(WINDOW_START) D, COUNT(*) N" + cols + " FROM DI_SQL_STATS_MIN "
                    + "WHERE ASSET_ID=? AND INSTANCE_ID=? AND WINDOW_START >= ? AND DATA_QUALITY='NORMAL' AND NVL(EXCLUDE_BASELINE, 0) = 0 "
                    + "GROUP BY TRUNC(WINDOW_START) ORDER BY D", asset, instanceId, from);
            for (Metric m : DEGRADATION_METRICS) {
                Map<String, List<Double>> series = new LinkedHashMap<>();
                List<Double> vals = new ArrayList<>();
                for (Map<String, Object> d : days) {
                    if (Values.toLong(d.get("N"), 0) >= 60) {       // 一天至少 60 个窗口才算数
                        vals.add(Values.toDouble(d.get(m.column)));
                    }
                }
                series.put(m.key, vals);
                Degradation dg = detectDegradation(asset, m, vals, ratio);
                if (dg != null) {
                    out.add(dg);
                }
            }
        }
        return out;
    }

    /**
     * 纯函数：日中位数序列（旧→新）。最近 3 天都 ≥ ratio × 历史（第 8 天及更早）日中位数的中位数，且最近 3 天不下降 → 缓慢劣化。
     * 历史不足 7 天不判断。
     */
    public static Degradation detectDegradation(long assetId, Metric m, List<Double> daily, double ratio) {
        if (daily == null || daily.size() < 10) {
            return null;
        }
        int n = daily.size();
        List<Double> hist = daily.subList(0, n - 7);
        if (hist.size() < 3) {
            return null;
        }
        double base = RobustStats.median(hist);
        List<Double> last = daily.subList(n - 3, n);
        if (!(base > 0)) {
            return null;
        }
        for (Double v : last) {
            if (v == null || v < ratio * base) {
                return null;
            }
        }
        if (last.get(2) < last.get(0)) {
            return null;
        }
        double recent = RobustStats.median(last);
        return new Degradation(assetId, m, recent, base, recent / base, new ArrayList<>(last));
    }
}
