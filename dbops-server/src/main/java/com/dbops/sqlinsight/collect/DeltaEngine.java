package com.dbops.sqlinsight.collect;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 累计值 → 分钟增量（设计方案 3.2）。数据质量：
 * <ul>
 *   <li>BASELINE：首次见到（无上一次快照），只记录不入库</li>
 *   <li>RESET：任一计数器回退（实例重启、游标老化、统计被清空），本窗口丢弃</li>
 *   <li>GAP：距上次快照超过 gapFactor 个周期（采集中断），本窗口丢弃</li>
 *   <li>PARTIAL：支持的计数器本次或上次缺值，可入库但不进基线</li>
 *   <li>NORMAL：正常</li>
 * </ul>
 * 上一次快照保存在内存（按实例），节点重启后第一轮全部为 BASELINE —— 这是正确行为：重启期间的增量本就不可知。
 */
public class DeltaEngine {

    public static final String NORMAL = "NORMAL";
    public static final String PARTIAL = "PARTIAL";
    public static final String BASELINE = "BASELINE";
    public static final String RESET = "RESET";
    public static final String GAP = "GAP";

    private record Prev(SqlCounters c, long ts) {
    }

    private record InstState(Map<String, Prev> prev, long[] lastRun) {
    }

    private final Map<Long, InstState> state = new ConcurrentHashMap<>();
    private final double gapFactor;
    private final long evictMs;

    public DeltaEngine() {
        this(3.0, 2 * 3600_000L);
    }

    public DeltaEngine(double gapFactor, long evictMs) {
        this.gapFactor = gapFactor;
        this.evictMs = evictMs;
    }

    /** 统计（不入库）窗口的计数 */
    public record Result(List<WindowRow> rows, int baseline, int reset, int gap, int idle) {
    }

    /**
     * @param activityFiltered 源视图是否按“最近活跃”过滤（Oracle/MySQL/磐维/SQLServer）。过滤时某条 SQL 一段时间没出现
     *                         只说明它没执行，增量仍然有效；不过滤（PG 取 Top N）时，长时间没出现可能是掉出了 Top N，按 GAP 处理
     */
    public Result compute(long instanceId, List<SqlCounters> snapshot, long nowMs, long intervalMs, boolean activityFiltered) {
        InstState st = state.computeIfAbsent(instanceId, k -> new InstState(new ConcurrentHashMap<>(), new long[]{0}));
        long lastRun = st.lastRun()[0];
        boolean instanceGap = lastRun > 0 && nowMs - lastRun > gapFactor * intervalMs;
        List<WindowRow> out = new ArrayList<>();
        int baseline = 0, reset = 0, gap = 0, idle = 0;
        for (SqlCounters c : snapshot) {
            Prev p = st.prev().put(c.key(), new Prev(c, nowMs));
            if (p == null) {
                baseline++;
                continue;
            }
            if (instanceGap || (!activityFiltered && nowMs - p.ts() > gapFactor * intervalMs)) {
                gap++;
                continue;
            }
            double[] d = new double[Counter.SIZE];
            boolean partial = false;
            boolean decreased = false;
            for (Counter k : Counter.values()) {
                double a = c.get(k);
                double b = p.c().get(k);
                if (Double.isNaN(a) && Double.isNaN(b)) {
                    d[k.ordinal()] = Double.NaN;
                } else if (Double.isNaN(a) || Double.isNaN(b)) {
                    d[k.ordinal()] = Double.NaN;
                    partial = true;
                } else if (a < b) {
                    decreased = true;
                } else {
                    d[k.ordinal()] = a - b;
                }
            }
            if (decreased) {
                reset++;
                continue;
            }
            if (!(d[Counter.EXEC.ordinal()] > 0)) {
                idle++;
                continue;
            }
            // 窗口长度按“该 SQL 上次被看到”计算，而不是按实例上次采集：按活跃过滤的视图里，一条 SQL 隔了 30 分钟
            // 才再次出现时，增量是 30 分钟累计的，原来除以 1 分钟会把每分钟执行次数/耗时放大 30 倍、误报波动
            double minutes = Math.max(0.05, (nowMs - p.ts()) / 60000.0);
            // 跨了多个周期的窗口是平均值，可入库展示但不进基线
            boolean longWindow = nowMs - p.ts() > gapFactor * intervalMs;
            out.add(new WindowRow(c, d, minutes, partial || longWindow ? PARTIAL : NORMAL));
        }
        st.lastRun()[0] = nowMs;
        // 长时间未出现的条目清理，避免内存无限增长
        for (Iterator<Map.Entry<String, Prev>> it = st.prev().entrySet().iterator(); it.hasNext(); ) {
            if (nowMs - it.next().getValue().ts() > evictMs) {
                it.remove();
            }
        }
        // DB_TIME_SHARE 分母：本窗口全部有效 SQL 的耗时之和（近似值，未采集到的 SQL 不在分母里）
        double total = 0;
        for (WindowRow r : out) {
            double e = r.d(Counter.ELAPSED_MS);
            if (!Double.isNaN(e)) {
                total += e;
            }
        }
        for (WindowRow r : out) {
            r.computeMetrics(total);
        }
        return new Result(out, baseline, reset, gap, idle);
    }

    /** 采集失败时调用：丢弃该实例的上一次快照，下次成功采集重新从 BASELINE 开始（失败期间的增量不可知） */
    public void forget(long instanceId) {
        state.remove(instanceId);
    }
}
