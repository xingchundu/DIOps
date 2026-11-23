package com.dbops.sqlinsight.anomaly;

import com.dbops.sqlinsight.baseline.Baseline;
import com.dbops.sqlinsight.baseline.RobustStats;
import com.dbops.sqlinsight.collect.Metric;

import java.util.List;

/**
 * 波动判定（设计方案 5.3）。纯函数。
 * <p>
 * 单窗口“五项判定”全部满足才记一次命中：
 * <ol>
 *   <li>基线可用：样本数 ≥ minSamples</li>
 *   <li>倍率：当前值 / 基线中位数 ≥ ratio（下降类指标 ≤ 1/ratio）</li>
 *   <li>稳健 Z 分数 ≥ z</li>
 *   <li>绝对变化量 ≥ minAbs（避免 1ms → 3ms 这种“翻倍”）</li>
 *   <li>样本量：本窗口执行次数 ≥ minExec，且数据质量 NORMAL</li>
 * </ol>
 * 波动类型：
 * <ul>
 *   <li>SPIKE 突增：单窗口命中且倍率 ≥ spikeRatio（只记录，不告警）</li>
 *   <li>SUSTAINED 持续升高：最近 window 个窗口中命中 ≥ need 个（默认 5 中 3）</li>
 *   <li>SLOW_DEGRADATION 缓慢劣化：按天判断，见 BaselineService.detectDegradation</li>
 * </ul>
 * 恢复：连续 recoverWindows 个窗口当前值 &lt; recoverRatio × 基线。
 */
public final class AnomalyDetector {

    public enum Direction { UP, DOWN }

    /** 指标的检测参数 */
    public record Spec(Metric metric, Direction direction, double ratio, double minAbs) {
    }

    /** 检测全局参数（SYS_CONFIG 可调） */
    public record Params(int minSamples, double z, int minExec, double spikeRatio, int window, int need,
                         double recoverRatio, int recoverWindows) {
        public static final Params DEFAULTS = new Params(30, 3.5, 5, 5.0, 5, 3, 1.5, 10);
    }

    public record Check(boolean hit, double ratio, double z, String reason) {
    }

    public static final List<Spec> SPECS = List.of(
            new Spec(Metric.AVG_ELAPSED_MS, Direction.UP, 2.0, 50),
            new Spec(Metric.CPU_PER_EXEC_MS, Direction.UP, 2.0, 20),
            new Spec(Metric.LOGICAL_READS_PER_EXEC, Direction.UP, 2.0, 1000),
            new Spec(Metric.PHYSICAL_READS_PER_EXEC, Direction.UP, 3.0, 100),
            new Spec(Metric.ROWS_EXAMINED_PER_EXEC, Direction.UP, 2.0, 1000),
            new Spec(Metric.SCAN_RATIO, Direction.UP, 3.0, 10),
            new Spec(Metric.EXEC_PER_MIN, Direction.UP, 3.0, 100),
            new Spec(Metric.EXEC_PER_MIN, Direction.DOWN, 3.0, 100),
            new Spec(Metric.DB_TIME_SHARE, Direction.UP, 2.0, 0.05),
            new Spec(Metric.ERROR_RATE, Direction.UP, 3.0, 0.01));

    /** 倍率上限（写库与展示用） */
    public static final double RATIO_CAP = 999;

    private AnomalyDetector() {
    }

    public static Check check(Spec s, Double current, Baseline b, double execInWindow, boolean normalQuality, Params p) {
        if (current == null || Double.isNaN(current) || Double.isInfinite(current)) {
            return new Check(false, 0, 0, "无当前值");
        }
        if (b == null || b.samples() < p.minSamples()) {
            return new Check(false, 0, 0, "基线样本不足");
        }
        if (!normalQuality) {
            return new Check(false, 0, 0, "数据质量非 NORMAL");
        }
        double med = b.median();
        // 基线中位数为 0（平时几乎不执行/不报错）时倍率没有意义：原来记为 Infinity，写库（NUMBER）与 JSON 序列化都会出错。
        // 以 RATIO_CAP 封顶，是否告警仍由 Z 分数与绝对变化量共同决定
        double ratio = med > 0 ? Math.min(current / med, RATIO_CAP) : (current > 0 ? RATIO_CAP : 1);
        double z = RobustStats.robustZ(current, med, b.mad(), 0.05, s.minAbs() / 10);
        boolean ratioOk;
        boolean absOk;
        if (s.direction() == Direction.UP) {
            ratioOk = ratio >= s.ratio();
            absOk = current - med >= s.minAbs();
            // 执行次数类指标本身就是样本量，其余指标要求本窗口有足够执行次数
            if (s.metric() != Metric.EXEC_PER_MIN && execInWindow < p.minExec()) {
                return new Check(false, ratio, z, "本窗口执行次数不足");
            }
        } else {
            ratioOk = ratio <= 1.0 / s.ratio();
            absOk = med - current >= s.minAbs();
        }
        boolean zOk = z >= p.z();
        boolean hit = ratioOk && zOk && absOk;
        return new Check(hit, ratio, z, hit ? "命中" : (!ratioOk ? "倍率不足" : !zOk ? "Z 分数不足" : "绝对变化量不足"));
    }

    /** flags（新→旧，含本窗口）里该位为 1 的个数是否满足“window 中 need” */
    public static boolean sustained(List<Integer> flagsNewestFirst, int bit, Params p) {
        if (flagsNewestFirst == null) {
            return false;
        }
        int hits = 0;
        for (int i = 0; i < Math.min(p.window(), flagsNewestFirst.size()); i++) {
            Integer f = flagsNewestFirst.get(i);
            if (f != null && (f & bit) != 0) {
                hits++;
            }
        }
        return hits >= p.need();
    }

    public static int bit(Spec s) {
        // DOWN 方向占用高位，避免和同一指标的 UP 冲突
        return s.direction() == Direction.UP ? s.metric().bit() : (s.metric().bit() << 16);
    }

    /** 是否仍处于“未恢复”状态（用于恢复计数） */
    public static boolean stillElevated(Spec s, Double current, Baseline b, Params p) {
        if (current == null || b == null || b.median() <= 0) {
            return false;
        }
        double r = current / b.median();
        return s.direction() == Direction.UP ? r >= p.recoverRatio() : r <= 1.0 / p.recoverRatio();
    }

    /** 级别：倍率 ≥ 5 或资源占比 ≥ 20% 为 CRITICAL */
    public static String severity(double ratio, Double dbTimeShare) {
        return ratio >= 5 || (dbTimeShare != null && dbTimeShare >= 0.2) ? "CRITICAL" : "WARNING";
    }
}
