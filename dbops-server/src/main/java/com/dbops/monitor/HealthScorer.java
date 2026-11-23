package com.dbops.monitor;

import com.dbops.common.R;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

/**
 * 健康评分（扣分制，可解释）。纯函数。
 *
 * <h3>规则</h3>
 * <ol>
 *   <li>满分 100。按“检查项”逐项判断：正常不扣分；达到警告阈值扣 10 分（个别轻微项 5 分）；达到严重阈值扣 25 分。</li>
 *   <li>某项没有采集到数据：不扣分，也不计入“已检查项”，在明细里标为“未采集”（原来按 50 分计，没采到反而拉低分数）。</li>
 *   <li>封顶：存在任一严重项，总分最高 59；存在任一警告项，总分最高 89。所以分数段与结论一一对应——
 *       ≥90 健康（没有任何问题）、60~89 关注（有警告）、&lt;60 严重（有严重问题）。加权平均会把“表空间 99%”这类单点问题摊薄，扣分制不会。</li>
 *   <li>连接失败：不打分，状态为“离线”（库里 HEALTH_SCORE 记 0，供告警规则使用；界面显示“离线”而不是 0 分）。</li>
 *   <li>负载按“占上限的比例”判断（连接数 / 最大连接数），不再用“活跃会话 / 固定 200”这类与配置无关的绝对值。</li>
 * </ol>
 *
 * <h3>检查项（按库类型取适用项）</h3>
 * <pre>
 * 可用性   实例状态、监听、集群资源、主备复制、近期重启
 * 容量     表空间最大使用率、快速恢复区、主机文件系统
 * 性能     缓存命中率、log file sync、慢查询增量、Page Life Expectancy、回滚比例、ORA-4031、检查点未完成
 * 会话与锁 连接数占上限比例、阻塞时长、锁等待、事务空闲、死锁、运行线程
 * 主机     CPU 使用率、内存使用率
 * 数据保护 最近全备距今、归档模式
 * </pre>
 */
public final class HealthScorer {

    public static final int WARN_DEDUCT = 10;
    public static final int CRIT_DEDUCT = 25;

    private HealthScorer() {
    }

    public enum Level { OK, WARN, CRIT }

    public static final Map<String, String> CATEGORIES = Map.of(
            "availability", "可用性", "capacity", "容量", "performance", "性能",
            "session", "会话与锁", "host", "主机", "protection", "数据保护");
    private static final List<String> CATEGORY_ORDER = List.of("availability", "capacity", "performance", "session", "host", "protection");

    /**
     * @param score       0~100（离线为 0）
     * @param grade       HEALTHY / ATTENTION / CRITICAL / OFFLINE
     * @param dimensions  按分类汇总（兼容原“维度”展示），以及 issues / checked / keyMetrics，整体存 HEALTH_DETAIL
     */
    public record Score(int score, String grade, Map<String, Object> dimensions) {
    }

    /** 一条判定结果 */
    public record Finding(String category, String item, Level level, Double value, String text, int deduct) {
    }

    /** 统一的指标读取：exporter 指标按名称，引擎 / 主机指标按 key */
    public static final class Snapshot {
        final List<Map<String, Object>> exporter;
        final List<Map<String, Object>> keyed;

        public Snapshot(List<Map<String, Object>> exporter, List<Map<String, Object>> engine, List<Map<String, Object>> host) {
            this.exporter = exporter == null ? List.of() : exporter;
            List<Map<String, Object>> k = new ArrayList<>();
            if (engine != null) {
                k.addAll(engine);
            }
            if (host != null) {
                k.addAll(host);
            }
            this.keyed = k;
        }

        public Double v(String name) {
            Double x = Metrics.exporterValue(exporter, name);
            return x != null ? x : Metrics.keyValue(keyed, name);
        }

        Double first(String... names) {
            for (String n : names) {
                Double x = v(n);
                if (x != null) {
                    return x;
                }
            }
            return null;
        }
    }

    // ------------------------------------------------------------------ 入口

    public static Score offline(String errMsg) {
        Map<String, Object> d = new LinkedHashMap<>();
        d.put("version", 2);
        d.put("grade", "OFFLINE");
        d.put("issues", List.of(issue(new Finding("availability", "连接", Level.CRIT, null, "连接失败：" + (errMsg == null ? "" : errMsg), 100))));
        d.put("checked", 1);
        d.put("keyMetrics", Map.of());
        Map<String, Object> cats = new LinkedHashMap<>();
        for (String c : CATEGORY_ORDER) {
            cats.put(c, R.map("score", c.equals("availability") ? 0 : null, "label", CATEGORIES.get(c),
                    "detail", c.equals("availability") ? "连接失败" : "实例不可达", "status", c.equals("availability") ? "CRIT" : "NA"));
        }
        d.put("categories", cats);
        return new Score(0, "OFFLINE", d);
    }

    public static Score compute(String engine, Snapshot s) {
        String e = DbType.metricEngine(engine);
        String raw = DbType.normalize(engine);
        List<Finding> fs = new ArrayList<>();
        int[] checked = {0};

        // ---------------- 可用性
        check(fs, checked, "availability", "实例状态", s.first("oracle_instance_up", "panwei_instance_up"), v -> v < 1 ? Level.CRIT : Level.OK,
                v -> "实例未处于 OPEN 状态", CRIT_DEDUCT);
        check(fs, checked, "availability", "监听", s.v("host_listener_ready"), v -> v < 1 ? Level.WARN : Level.OK, v -> "监听未就绪", WARN_DEDUCT);
        check(fs, checked, "availability", "集群资源", s.v("host_crs_resource_offline"), v -> v > 0 ? Level.CRIT : Level.OK,
                v -> "集群有 " + n(v) + " 个资源 OFFLINE", CRIT_DEDUCT);
        check(fs, checked, "availability", "集群状态", s.v("panwei_gs_om_cluster_abnormal"), v -> v > 0 ? Level.CRIT : Level.OK,
                v -> "集群状态异常", CRIT_DEDUCT);
        check(fs, checked, "availability", "主备复制", s.v("panwei_replication_not_streaming_count"), v -> v > 0 ? Level.CRIT : Level.OK,
                v -> n(v) + " 个备库未处于同步状态", CRIT_DEDUCT);
        Double uptimeH = s.first("oracle_uptime_hours", "panwei_uptime_hours");
        if (uptimeH == null && s.v("mysql_global_status_uptime_seconds") != null) {
            uptimeH = s.v("mysql_global_status_uptime_seconds") / 3600;
        }
        check(fs, checked, "availability", "近期重启", uptimeH, v -> v < 1 ? Level.WARN : Level.OK,
                v -> "实例在 " + Math.max(1, Math.round(v * 60)) + " 分钟前重启", 5);

        // ---------------- 容量
        check(fs, checked, "capacity", "表空间", s.first("oracle_tablespace_max_used_pct", "db_tablespace_max_used_pct"), hi(85, 95),
                v -> "表空间最大使用率 " + p(v), WARN_DEDUCT);
        check(fs, checked, "capacity", "快速恢复区", s.v("oracle_fra_used_pct"), hi(80, 90), v -> "快速恢复区使用率 " + p(v), WARN_DEDUCT);
        check(fs, checked, "capacity", "文件系统", s.v("host_fs_used_pct_max"), hi(85, 95), v -> "主机文件系统最大使用率 " + p(v), WARN_DEDUCT);

        // ---------------- 性能
        Double hit = switch (e) {
            case DbType.ORACLE, DbType.DAMENG -> s.first("Buffer Cache Hit Ratio", "oracle_buffer_cache_hit_pct");
            case DbType.MYSQL -> s.v("mysql_innodb_buffer_pool_hit_ratio");
            case DbType.POSTGRESQL -> s.first("panwei_buffer_hit_pct", "pg_buffer_cache_hit_ratio");
            case DbType.SQLSERVER -> s.v("mssql_buffer_cache_hit_ratio");
            default -> null;
        };
        check(fs, checked, "performance", "缓存命中率", hit, lo(95, 90), v -> "缓存命中率 " + p(v), WARN_DEDUCT);
        check(fs, checked, "performance", "提交等待", s.v("oracle_log_file_sync_ms"), hi(10, 30), v -> "log file sync 平均 " + r1(v) + " ms", WARN_DEDUCT);
        check(fs, checked, "performance", "慢查询", s.v("mysql_slow_queries_delta"), hi(10, 100), v -> "本周期新增慢查询 " + n(v) + " 条", WARN_DEDUCT);
        check(fs, checked, "performance", "页面驻留时间", s.v("mssql_page_life_expectancy"), lo(300, 60), v -> "Page Life Expectancy " + n(v) + " 秒", WARN_DEDUCT);
        check(fs, checked, "performance", "共享池", s.v("oracle_alert_ora_4031_24h"), v -> v > 0 ? Level.WARN : Level.OK,
                v -> "近 24 小时出现 ORA-4031 " + n(v) + " 次", WARN_DEDUCT);
        check(fs, checked, "performance", "检查点", s.v("oracle_alert_checkpoint_incomplete_24h"), v -> v > 0 ? Level.WARN : Level.OK,
                v -> "近 24 小时检查点未完成 " + n(v) + " 次", 5);
        Double rb = s.v("pg_stat_database_xact_rollback");
        Double cm = s.v("pg_stat_database_xact_commit");
        Double rbPct = rb == null || cm == null || rb + cm < 1000 ? null : rb * 100 / (rb + cm);
        check(fs, checked, "performance", "事务回滚", rbPct, hi(5, 20), v -> "事务回滚比例 " + p(v), WARN_DEDUCT);

        // ---------------- 会话与锁
        check(fs, checked, "session", "连接数", s.first("db_conn_used_pct", "panwei_conn_used_pct"), hi(80, 95),
                v -> "连接数达到上限的 " + p(v), WARN_DEDUCT);
        check(fs, checked, "session", "阻塞", s.v("oracle_blocking_session_max_sec"), hi(60, 300), v -> "存在阻塞，最长 " + n(v) + " 秒", WARN_DEDUCT);
        check(fs, checked, "session", "锁等待", s.v("panwei_lock_wait_count"), hi(5, 20), v -> n(v) + " 个会话在等锁", WARN_DEDUCT);
        check(fs, checked, "session", "空闲事务", s.v("panwei_idle_in_txn_over_5min"), hi(1, 5), v -> n(v) + " 个事务空闲超过 5 分钟未提交", WARN_DEDUCT);
        check(fs, checked, "session", "死锁", s.v("oracle_alert_ora_00060_24h"), v -> v > 0 ? Level.WARN : Level.OK,
                v -> "近 24 小时死锁 " + n(v) + " 次", 5);
        if (DbType.MYSQL.equals(e)) {
            check(fs, checked, "session", "运行线程", s.v("mysql_global_status_threads_running"), hi(30, 80), v -> "运行中线程 " + n(v), WARN_DEDUCT);
        }

        // ---------------- 主机
        check(fs, checked, "host", "CPU", s.first("host_cpu_used_pct", "Host CPU Utilization (%)"), hi(80, 95), v -> "CPU 使用率 " + p(v), WARN_DEDUCT);
        check(fs, checked, "host", "内存", s.v("host_mem_used_pct"), hi(90, 97), v -> "内存使用率 " + p(v), WARN_DEDUCT);

        // ---------------- 数据保护
        check(fs, checked, "protection", "备份", s.v("oracle_rman_full_backup_hours_ago"), hi(7 * 24, 14 * 24),
                v -> "最近一次全备在 " + Math.round(v / 24) + " 天前", WARN_DEDUCT);
        check(fs, checked, "protection", "归档模式", s.v("oracle_is_archivelog"), v -> v < 1 ? Level.WARN : Level.OK, v -> "未开启归档模式", 5);

        return summarize(fs, checked[0], keyMetrics(e, raw, s));
    }

    // ------------------------------------------------------------------ 汇总

    static Score summarize(List<Finding> fs, int checked, Map<String, Object> keyMetrics) {
        int deduct = 0;
        boolean crit = false;
        boolean warn = false;
        List<Map<String, Object>> issues = new ArrayList<>();
        for (Finding f : fs) {
            if (f.level() == Level.OK) {
                continue;
            }
            deduct += f.deduct();
            crit |= f.level() == Level.CRIT;
            warn |= f.level() == Level.WARN;
            issues.add(issue(f));
        }
        issues.sort((a, b) -> Integer.compare((int) b.get("deduct"), (int) a.get("deduct")));
        int score = Math.max(0, 100 - deduct);
        if (crit) {
            score = Math.min(score, 59);
        } else if (warn) {
            score = Math.min(score, 89);
        }
        String grade = grade(score);

        Map<String, Object> cats = new LinkedHashMap<>();
        for (String c : CATEGORY_ORDER) {
            List<Finding> in = fs.stream().filter(f -> f.category().equals(c)).toList();
            if (in.isEmpty()) {
                cats.put(c, R.map("score", null, "label", CATEGORIES.get(c), "detail", "未采集", "status", "NA", "checked", 0));
                continue;
            }
            int d = in.stream().mapToInt(f -> f.level() == Level.OK ? 0 : f.deduct()).sum();
            Finding worst = in.stream().filter(f -> f.level() != Level.OK).max((a, b) -> Integer.compare(a.deduct(), b.deduct())).orElse(null);
            String st = in.stream().anyMatch(f -> f.level() == Level.CRIT) ? "CRIT" : worst != null ? "WARN" : "OK";
            cats.put(c, R.map("score", Math.max(0, 100 - d), "label", CATEGORIES.get(c), "detail", worst == null ? "正常" : worst.text(),
                    "status", st, "checked", in.size()));
        }
        Map<String, Object> d = new LinkedHashMap<>();
        d.put("version", 2);
        d.put("grade", grade);
        d.put("issues", issues);
        d.put("checked", checked);
        d.put("keyMetrics", keyMetrics);
        d.put("categories", cats);
        return new Score(score, grade, d);
    }

    public static String grade(Integer score) {
        if (score == null) {
            return "OFFLINE";
        }
        return score >= 90 ? "HEALTHY" : score >= 60 ? "ATTENTION" : "CRITICAL";
    }

    private static Map<String, Object> issue(Finding f) {
        return R.map("category", f.category(), "categoryLabel", CATEGORIES.get(f.category()), "item", f.item(), "level", f.level().name(),
                "value", f.value() == null ? null : Metrics.round2(f.value()), "text", f.text(), "deduct", f.deduct());
    }

    private static void check(List<Finding> out, int[] checked, String cat, String item, Double v, Function<Double, Level> judge,
                              Function<Double, String> text, int warnDeduct) {
        if (v == null || v.isNaN()) {
            return;   // 未采集：不扣分、不计数
        }
        checked[0]++;
        Level l = judge.apply(v);
        int d = l == Level.CRIT ? Math.max(CRIT_DEDUCT, warnDeduct) : l == Level.WARN ? warnDeduct : 0;
        out.add(new Finding(cat, item, l, v, l == Level.OK ? item + "正常" : text.apply(v), d));
    }

    /** 越高越差：≥warn 警告，≥crit 严重 */
    static Function<Double, Level> hi(double warn, double crit) {
        return v -> v >= crit ? Level.CRIT : v >= warn ? Level.WARN : Level.OK;
    }

    /** 越低越差：&lt;warn 警告，&lt;crit 严重 */
    static Function<Double, Level> lo(double warn, double crit) {
        return v -> v < crit ? Level.CRIT : v < warn ? Level.WARN : Level.OK;
    }

    private static String p(double v) {
        return String.format("%.1f%%", v);
    }

    private static String r1(double v) {
        return String.format("%.1f", v);
    }

    private static String n(double v) {
        return String.valueOf(Math.round(v));
    }

    // ------------------------------------------------------------------ 关键指标（监控中心卡片直接展示）

    static Map<String, Object> keyMetrics(String e, String raw, Snapshot s) {
        Map<String, Object> m = new LinkedHashMap<>();
        put(m, "cpu", s.first("host_cpu_used_pct", "Host CPU Utilization (%)"));
        put(m, "mem", s.v("host_mem_used_pct"));
        put(m, "connPct", s.first("db_conn_used_pct", "panwei_conn_used_pct"));
        put(m, "conn", switch (e) {
            case DbType.ORACLE, DbType.DAMENG -> s.first("db_conn_current", "Current Logons Count");
            case DbType.MYSQL -> s.v("mysql_global_status_threads_connected");
            case DbType.POSTGRESQL -> s.first("db_conn_current", "pg_stat_database_numbackends");
            case DbType.SQLSERVER -> s.v("mssql_user_connections");
            default -> null;
        });
        put(m, "connMax", s.v("db_conn_max"));
        put(m, "active", switch (e) {
            case DbType.ORACLE, DbType.DAMENG -> s.first("Active Sessions", "db_active_sessions");
            case DbType.MYSQL -> s.v("mysql_global_status_threads_running");
            case DbType.POSTGRESQL -> s.v("pg_stat_activity_active");
            case DbType.SQLSERVER -> s.v("mssql_active_sessions");
            default -> null;
        });
        put(m, "hit", switch (e) {
            case DbType.ORACLE, DbType.DAMENG -> s.first("Buffer Cache Hit Ratio", "oracle_buffer_cache_hit_pct");
            case DbType.MYSQL -> s.v("mysql_innodb_buffer_pool_hit_ratio");
            case DbType.POSTGRESQL -> s.first("panwei_buffer_hit_pct", "pg_buffer_cache_hit_ratio");
            case DbType.SQLSERVER -> s.v("mssql_buffer_cache_hit_ratio");
            default -> null;
        });
        put(m, "tsMax", s.first("oracle_tablespace_max_used_pct", "db_tablespace_max_used_pct"));
        put(m, "fsMax", s.v("host_fs_used_pct_max"));
        put(m, "tps", switch (e) {
            case DbType.ORACLE -> s.v("User Calls Per Sec");
            case DbType.MYSQL -> s.v("mysql_qps");
            case DbType.SQLSERVER -> s.v("mssql_batch_requests_per_sec");
            default -> null;
        });
        m.put("tpsLabel", switch (e) {
            case DbType.ORACLE -> "调用/秒";
            case DbType.MYSQL -> "QPS";
            case DbType.SQLSERVER -> "批请求/秒";
            default -> null;
        });
        return m;
    }

    private static void put(Map<String, Object> m, String k, Double v) {
        if (v != null && !v.isNaN()) {
            m.put(k, Metrics.round2(v));
        }
    }

    /**
     * 趋势图的 CPU / 连接数。
     * 有 SSH 主机 CPU 时优先用主机 CPU；Oracle/达梦用 Host CPU Utilization (%)；MySQL/PG 用“运行中/连接”比例近似。
     */
    public static Double[] trend(String engine, List<Map<String, Object>> metrics, Double hostCpuPct) {
        String e = DbType.metricEngine(engine);
        Double cpu = null;
        Double conn = null;
        switch (e) {
            case DbType.ORACLE, DbType.DAMENG -> {
                cpu = Metrics.exporterValue(metrics, "Host CPU Utilization (%)");
                conn = firstNonNull(Metrics.exporterValue(metrics, "Current Logons Count"), Metrics.exporterValue(metrics, "Active Sessions"));
            }
            case DbType.MYSQL -> {
                conn = Metrics.exporterValue(metrics, "mysql_global_status_threads_connected");
                Double running = Metrics.exporterValue(metrics, "mysql_global_status_threads_running");
                if (conn != null && conn > 0 && running != null) {
                    cpu = Math.min(100, Metrics.round2(running / conn * 100));
                }
            }
            case DbType.POSTGRESQL -> {
                conn = Metrics.exporterValue(metrics, "pg_stat_database_numbackends");
                Double active = Metrics.exporterValue(metrics, "pg_stat_activity_active");
                if (conn != null && conn > 0 && active != null) {
                    cpu = Math.min(100, Metrics.round2(active / conn * 100));
                }
            }
            case DbType.SQLSERVER -> {
                cpu = Metrics.exporterValue(metrics, "mssql_active_sessions");
                conn = Metrics.exporterValue(metrics, "mssql_user_connections");
            }
            default -> {
            }
        }
        if (hostCpuPct != null) {
            cpu = hostCpuPct;
        }
        return new Double[]{cpu, conn};
    }

    private static Double firstNonNull(Double a, Double b) {
        return a != null ? a : b;
    }
}
