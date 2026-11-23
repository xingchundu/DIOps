package com.dbops.sqlinsight.diagnosis;

import com.dbops.sqlinsight.collect.Metric;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 原因分类 —— 按《SQL 问题识别与异常波动检测设计方案》6.2 节实现。纯函数。
 * <p>
 * “升高”指比值 ≥ 1.5，“稳定”指比值 &lt; 1.2；缺失指标按 NaN 处理，既不算升高也不算稳定（不把未采集误判成某种原因）。
 * 多个原因同时满足时按表格优先级顺序全部列出；都不满足为 UNKNOWN。
 * 发布 / 批处理 / 参数变更不单独成为原因，作为证据附在结果里（方案 6.1 诊断快照）。
 *
 * <pre>
 * 优先级 原因                 指标特征                                      建议动作
 * 1      PLAN_REGRESSION      出现新计划，且单次耗时或单次逻辑读升高        对比新旧计划，检查统计信息
 * 2      LOCK_WAIT            单次耗时升高，CPU 和逻辑读稳定，存在锁等待/阻塞链  定位阻塞会话和事务
 * 3      DATA_GROWTH_OR_SKEW  计划不变，单次逻辑读或扫描行数升高            检查表增长、参数分布、统计信息
 * 4      CACHE_OR_IO          物理读升高且逻辑读稳定，或 I/O 等待升高        检查缓存命中率和磁盘延迟
 * 5      RESOURCE_CONTENTION  单次逻辑读稳定，实例 CPU 或运行队列升高        查找同时段资源消耗最高的 SQL
 * 6      TRAFFIC_SURGE        单次耗时稳定，执行次数升高                    检查业务流量、重试和 N+1
 * 7      ERROR_SURGE          错误率升高                                    按错误码分组，检查对象和权限变更
 * 8      UNKNOWN              不满足以上规则                                人工排查，结果沉淀为新规则
 * </pre>
 */
public final class CauseClassifier {

    public static final double UP = 1.5;
    public static final double STABLE = 1.2;

    /**
     * @param ratios        当前 / 基线 比值（缺失不放）
     * @param planSupported 源库统计视图是否提供计划标识（MySQL/PG/磐维/达梦没有，不下 PLAN_REGRESSION 结论）
     * @param newPlan       异常窗口出现了基线期没有的计划
     * @param newPlanDetail 例："14:02 出现新 plan_hash 1234，异常窗口中占比 96%"
     * @param lockWait      存在锁等待或阻塞链
     * @param instanceCpuRatio 实例 CPU 使用率 当前/基线（缺失为 NaN）
     * @param instanceIoWaitRatio 实例 I/O 等待 当前/基线（缺失为 NaN）
     * @param changes       同时段的发布/批处理/参数变更说明（证据，不作为原因）
     */
    public record Evidence(Map<Metric, Double> ratios, boolean planSupported, boolean newPlan, String newPlanDetail,
                           boolean lockWait, String lockDetail, double instanceCpuRatio, double instanceIoWaitRatio,
                           int concurrentAnomalies, boolean instanceScope, List<String> changes) {
        double r(Metric m) {
            Double v = ratios == null ? null : ratios.get(m);
            return v == null || v.isNaN() ? Double.NaN : v;
        }
    }

    public record Cause(String code, int priority, String title, List<String> evidence, List<String> suggestions) {
    }

    private CauseClassifier() {
    }

    static boolean up(double v) {
        return !Double.isNaN(v) && v >= UP;
    }

    static boolean stable(double v) {
        return !Double.isNaN(v) && v < STABLE;
    }

    static String x(double v) {
        return Double.isNaN(v) ? "未采集" : String.format("%.1f 倍", v);
    }

    public static List<Cause> classify(Evidence e) {
        List<Cause> out = new ArrayList<>();
        double elapsed = e.r(Metric.AVG_ELAPSED_MS);
        double lr = e.r(Metric.LOGICAL_READS_PER_EXEC);
        double pr = e.r(Metric.PHYSICAL_READS_PER_EXEC);
        double rows = e.r(Metric.ROWS_EXAMINED_PER_EXEC);
        double cpu = e.r(Metric.CPU_PER_EXEC_MS);
        double exec = e.r(Metric.EXEC_PER_MIN);
        double err = e.r(Metric.ERROR_RATE);

        // 1 PLAN_REGRESSION
        if (e.planSupported() && e.newPlan() && (up(elapsed) || up(lr))) {
            List<String> ev = new ArrayList<>();
            ev.add(e.newPlanDetail() == null ? "出现基线期没有的新执行计划" : e.newPlanDetail());
            if (up(elapsed)) {
                ev.add("单次耗时为基线的 " + x(elapsed));
            }
            if (up(lr)) {
                ev.add("单次逻辑读为基线的 " + x(lr));
            }
            out.add(new Cause("PLAN_REGRESSION", 1, "执行计划退化", ev, List.of("对比新旧执行计划", "检查相关表统计信息", "在测试环境验证后再处理（固定计划 / 更新统计信息）")));
        }
        // 2 LOCK_WAIT
        if (up(elapsed) && stable(cpu) && stable(lr) && e.lockWait()) {
            out.add(new Cause("LOCK_WAIT", 2, "锁等待", List.of("单次耗时为基线的 " + x(elapsed) + "，CPU 与逻辑读稳定",
                    e.lockDetail() == null ? "存在锁等待或阻塞链" : e.lockDetail()), List.of("定位阻塞会话和事务", "检查长事务、未提交事务", "缩短事务或调整更新顺序")));
        }
        // 3 DATA_GROWTH_OR_SKEW
        if (!e.newPlan() && (up(lr) || up(rows))) {
            List<String> ev = new ArrayList<>();
            ev.add(e.planSupported() ? "执行计划未变化" : "该库统计视图无计划标识，按计划未变处理");
            if (up(lr)) {
                ev.add("单次逻辑读为基线的 " + x(lr));
            }
            if (up(rows)) {
                ev.add("单次扫描行数为基线的 " + x(rows));
            }
            out.add(new Cause("DATA_GROWTH_OR_SKEW", 3, "数据增长或参数分布倾斜", ev, List.of("检查表数据增长", "检查绑定参数分布（是否命中热点值）", "检查统计信息是否过期")));
        }
        // 4 CACHE_OR_IO
        if ((up(pr) && stable(lr)) || up(e.instanceIoWaitRatio())) {
            List<String> ev = new ArrayList<>();
            if (up(pr) && stable(lr)) {
                ev.add("单次物理读为基线的 " + x(pr) + "，逻辑读稳定（" + x(lr) + "）");
            }
            if (up(e.instanceIoWaitRatio())) {
                ev.add("实例 I/O 等待为基线的 " + x(e.instanceIoWaitRatio()));
            }
            out.add(new Cause("CACHE_OR_IO", 4, "缓存命中下降或 I/O 变慢", ev, List.of("检查缓存命中率", "检查磁盘延迟", "排查同时段的大查询、备份、统计收集")));
        }
        // 5 RESOURCE_CONTENTION
        // 实例 CPU 升高，且（单次逻辑读稳定 或 实例级事件）——显式加括号，语义与原式相同
        if (up(e.instanceCpuRatio()) && (stable(lr) || e.instanceScope())) {
            List<String> ev = new ArrayList<>();
            ev.add("实例 CPU 使用率为基线的 " + x(e.instanceCpuRatio()));
            if (stable(lr)) {
                ev.add("单次逻辑读稳定（" + x(lr) + "）");
            }
            if (e.concurrentAnomalies() > 0) {
                ev.add("同实例另有 " + e.concurrentAnomalies() + " 条 SQL 同时波动");
            }
            out.add(new Cause("RESOURCE_CONTENTION", 5, "实例资源争用", ev, List.of("查找同时段资源消耗最高的 SQL", "检查批处理、备份、参数变更")));
        }
        // 6 TRAFFIC_SURGE
        if (stable(elapsed) && up(exec)) {
            out.add(new Cause("TRAFFIC_SURGE", 6, "调用量突增", List.of("单次耗时稳定（" + x(elapsed) + "）", "每分钟执行次数为基线的 " + x(exec)),
                    List.of("检查业务流量", "检查应用重试", "检查 N+1 查询")));
        }
        // 7 ERROR_SURGE
        if (up(err)) {
            out.add(new Cause("ERROR_SURGE", 7, "错误率升高", List.of("错误率为基线的 " + x(err)), List.of("按错误码分组", "检查对象和权限变更")));
        }
        if (out.isEmpty()) {
            List<String> ev = new ArrayList<>();
            ev.add("不满足已知规则（单次耗时 " + x(elapsed) + "，逻辑读 " + x(lr) + "，执行次数 " + x(exec) + "）");
            out.add(new Cause("UNKNOWN", 8, "原因未明", ev, List.of("人工排查", "结果沉淀为新规则")));
        }
        return out;
    }
}
