package com.dbops.monitor;

import com.dbops.common.R;
import com.dbops.common.Values;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 类 Prometheus Exporter 的拉取式采集（对应 Node services/monitorExporterCollect.js）。
 * 指标名与 Node 版保持一致（前端、告警规则、历史 METRICS_JSON 都依赖这些名字）。
 * <p>
 * 相对 Node 版的修正：
 * <ul>
 *   <li>Oracle 趋势 CPU 改用 "Host CPU Utilization (%)"（原 "Host CPU Usage Per Sec" 单位是 厘秒/秒，不是百分比）</li>
 *   <li>SQL Server Batch Requests/sec、MySQL Slow_queries/Questions 是累计计数器，改为按两次采样计算速率/增量</li>
 *   <li>Top SQL / 等待事件单位统一：*_TOTAL 为秒，AVG_* 为毫秒（原 MySQL/PG/SQL Server 各差 1000 倍）</li>
 *   <li>达梦 V$DATAFILE.TOTAL_SIZE/FREE_SIZE 单位是页，原按字节换算导致容量偏小数千倍</li>
 *   <li>达梦活跃会话为 0 时原逻辑硬写成 1</li>
 *   <li>PG 会话统计排除后台进程（autovacuum/walwriter 等原先被算成 INACTIVE 会话）</li>
 * </ul>
 */
@Component
public class ExporterCollector {

    private static final Logger log = LoggerFactory.getLogger(ExporterCollector.class);

    private final TargetConnector connector;
    private final CounterTracker counters = new CounterTracker();

    public ExporterCollector(TargetConnector connector) {
        this.connector = connector;
    }

    public CounterTracker counters() {
        return counters;
    }

    /** 采集元信息（只给程序用，界面不展示实现细节） */
    public static Map<String, Object> exporterMeta(String engine) {
        return R.map("engine", engine, "scrape_ts", Instant.now().toString());
    }

    // ========================= performance =========================

    public Map<String, Object> performance(long instanceId) throws SQLException {
        CmdbInstance inst = connector.fetch(instanceId);
        try (TargetDb t = connector.open(inst)) {
            return performance(t, inst);
        }
    }

    public Map<String, Object> performance(TargetDb t, CmdbInstance inst) throws SQLException {
        String type = inst.dbType();
        List<Map<String, Object>> metrics = new ArrayList<>();
        List<Map<String, Object>> sessions = new ArrayList<>();
        switch (type) {
            case DbType.ORACLE -> oraclePerformance(t, metrics, sessions);
            case DbType.MYSQL, DbType.GOLDENDB -> mysqlPerformance(t, inst.instanceId(), metrics, sessions);
            case DbType.POSTGRESQL, DbType.PANWEI -> pgPerformance(t, metrics, sessions);
            case DbType.DAMENG -> damengPerformance(t, metrics, sessions);
            case DbType.SQLSERVER -> sqlServerPerformance(t, inst.instanceId(), metrics, sessions);
            default -> throw new SQLException("监控采集不支持类型「" + type + "」");
        }
        connectionUsage(t, type, metrics, sessions);
        if (DbType.DAMENG.equals(type)) {
            damengTablespace(t, metrics);
        }
        return R.map("exporter", exporterMeta(type), "metrics", metrics, "sessions", sessions);
    }

    private void oraclePerformance(TargetDb t, List<Map<String, Object>> metrics, List<Map<String, Object>> sessions) throws SQLException {
        Map<String, Boolean> seen = new HashMap<>();
        for (Map<String, Object> r : t.query("SELECT METRIC_NAME, VALUE, METRIC_UNIT FROM V$SYSMETRIC "
                + "WHERE METRIC_NAME IN ('CPU Usage Per Sec','Host CPU Usage Per Sec','Host CPU Utilization (%)',"
                + "'Buffer Cache Hit Ratio','Shared Pool Free %','User Calls Per Sec','Logons Per Sec',"
                + "'Redo Generated Per Sec','Active Sessions','Current Logons Count') AND GROUP_ID=2")) {
            String name = Values.str(r.get("METRIC_NAME"));
            // CDB/RAC 下同一指标可能返回多行，取第一行
            if (name != null && seen.putIfAbsent(name, Boolean.TRUE) == null) {
                Metrics.addExporter(metrics, name, r.get("VALUE"), Values.str(r.get("METRIC_UNIT"), ""));
            }
        }
        if (!seen.containsKey("Host CPU Utilization (%)")) {
            Double os = oracleHostCpuFromOsstat(t);
            if (os != null) {
                Metrics.addExporter(metrics, "Host CPU Utilization (%)", os, "%");
            }
        }
        sessions.addAll(t.query("SELECT STATUS, COUNT(*) CNT FROM V$SESSION WHERE TYPE='USER' GROUP BY STATUS"));
        if (!seen.containsKey("Active Sessions")) {
            // 10.2 的 V$SYSMETRIC 没有 Active Sessions（11g 起才有这项）。V$SESSION.STATUS 从 10.2 起可用。
            Metrics.addExporter(metrics, "Active Sessions", activeUserSessions(sessions), "");
        }
    }

    /** 用户会话里 STATUS=ACTIVE 的个数。没有活跃会话时返回 0，避免监控中心显示成空。 */
    static long activeUserSessions(List<Map<String, Object>> sessions) {
        long active = 0;
        if (sessions == null) {
            return 0;
        }
        for (Map<String, Object> row : sessions) {
            if ("ACTIVE".equalsIgnoreCase(Values.str(row.get("STATUS"), ""))) {
                active += Values.toLong(row.get("CNT"), 0);
            }
        }
        return active;
    }

    /**
     * V$SYSMETRIC 没有主机 CPU 时，用 V$OSSTAT 的 BUSY/IDLE 做 1 秒差值。
     * 这是数据库所在主机的 CPU，不依赖 SSH。视图不可读时不产出指标。
     */
    private Double oracleHostCpuFromOsstat(TargetDb t) {
        double[] a = oracleOsTimes(t);
        if (a == null) {
            return null;
        }
        try {
            Thread.sleep(1000);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return null;
        }
        double[] b = oracleOsTimes(t);
        if (b == null) {
            return null;
        }
        double busy = b[0] - a[0];
        double idle = b[1] - a[1];
        double total = busy + idle;
        if (total <= 0) {
            return null;
        }
        return Math.min(100, Metrics.round2(busy / total * 100));
    }

    /** @return [busy, idle]，缺任一项返回 null */
    private static double[] oracleOsTimes(TargetDb t) {
        List<Map<String, Object>> rows = t.queryQuietly(
                "SELECT STAT_NAME, VALUE FROM V$OSSTAT WHERE STAT_NAME IN ('BUSY_TIME','IDLE_TIME')");
        if (rows == null || rows.isEmpty()) {
            return null;
        }
        Double busy = null;
        Double idle = null;
        for (Map<String, Object> row : rows) {
            String name = Values.str(row.get("STAT_NAME"));
            Double value = Values.toDouble(row.get("VALUE"));
            if (name == null || value == null) {
                continue;
            }
            if ("BUSY_TIME".equalsIgnoreCase(name)) {
                busy = value;
            } else if ("IDLE_TIME".equalsIgnoreCase(name)) {
                idle = value;
            }
        }
        return busy == null || idle == null ? null : new double[]{busy, idle};
    }

    /**
     * 连接数占上限的比例（健康评分“会话与锁”按比例判断，不再用固定绝对值）。
     * Oracle：V$PROCESS / processes；MySQL：Threads_connected / max_connections；PG·磐维：pg_stat_activity / max_connections；
     * 达梦：会话数 / MAX_SESSIONS。SQL Server 的上限默认 32767，没有参考意义，不计算。查不到时不输出，评分按“未采集”处理。
     */
    private void connectionUsage(TargetDb t, String type, List<Map<String, Object>> metrics, List<Map<String, Object>> sessions) {
        Double cur = null;
        Double max = null;
        switch (type) {
            case DbType.ORACLE -> {
                Map<String, Object> r = t.oneQuietly("SELECT (SELECT COUNT(*) FROM V$PROCESS) CUR, "
                        + "(SELECT TO_NUMBER(VALUE) FROM V$PARAMETER WHERE NAME = 'processes') MX FROM DUAL");
                if (r != null) {
                    cur = Values.toDouble(r.get("CUR"));
                    max = Values.toDouble(r.get("MX"));
                }
            }
            case DbType.MYSQL, DbType.GOLDENDB -> {
                Map<String, Object> r = t.oneQuietly("SELECT @@max_connections AS MX");
                cur = Metrics.exporterValue(metrics, "mysql_global_status_threads_connected");
                max = r == null ? null : Values.toDouble(r.get("MX"));
            }
            case DbType.POSTGRESQL, DbType.PANWEI -> {
                Map<String, Object> r = t.oneQuietly("SELECT (SELECT COUNT(*) FROM pg_stat_activity WHERE usename IS NOT NULL) AS cur, current_setting('max_connections')::int AS mx");
                if (r != null) {
                    cur = Values.toDouble(r.get("CUR"));
                    max = Values.toDouble(r.get("MX"));
                }
            }
            case DbType.DAMENG -> {
                Map<String, Object> r = t.oneQuietly("SELECT PARA_VALUE AS MX FROM V$DM_INI WHERE PARA_NAME = 'MAX_SESSIONS'");
                long total = 0;
                for (Map<String, Object> x : sessions) {
                    total += Values.toLong(x.get("CNT"), 0);
                }
                cur = (double) total;
                max = r == null ? null : Values.toDouble(r.get("MX"));
            }
            default -> {
                return;
            }
        }
        Metrics.addExporterIfPresent(metrics, "db_conn_current", cur, "");
        Metrics.addExporterIfPresent(metrics, "db_conn_max", max, "");
        if (cur != null && max != null && max > 0) {
            Metrics.addExporter(metrics, "db_conn_used_pct", Metrics.round2(cur * 100 / max), "%");
        }
    }

    /** 达梦表空间最大使用率（可自动扩展的数据文件按 MAXBYTES 计算上限）；视图不可用时不输出 */
    private void damengTablespace(TargetDb t, List<Map<String, Object>> metrics) {
        Map<String, Object> r = t.oneQuietly("SELECT MAX(ROUND((d.TOTAL - NVL(f.FREE, 0)) * 100 / d.CAP, 2)) AS PCT FROM "
                + "(SELECT TABLESPACE_NAME, SUM(BYTES) TOTAL, SUM(CASE WHEN AUTOEXTENSIBLE = 'YES' AND MAXBYTES > BYTES THEN MAXBYTES ELSE BYTES END) CAP "
                + "FROM DBA_DATA_FILES GROUP BY TABLESPACE_NAME) d LEFT JOIN "
                + "(SELECT TABLESPACE_NAME, SUM(BYTES) FREE FROM DBA_FREE_SPACE GROUP BY TABLESPACE_NAME) f ON f.TABLESPACE_NAME = d.TABLESPACE_NAME "
                + "WHERE d.CAP > 0");
        if (r != null) {
            Metrics.addExporterIfPresent(metrics, "db_tablespace_max_used_pct", Values.toDouble(r.get("PCT")), "%");
        }
    }

    private void mysqlPerformance(TargetDb t, long instanceId, List<Map<String, Object>> metrics,
                                  List<Map<String, Object>> sessions) throws SQLException {
        Map<String, Double> map = new HashMap<>();
        for (Map<String, Object> r : t.query("SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected','Threads_running',"
                + "'Questions','Uptime','Bytes_received','Bytes_sent','Innodb_buffer_pool_read_requests',"
                + "'Innodb_buffer_pool_reads','Slow_queries','Connections')")) {
            map.put(Values.str(r.get("VARIABLE_NAME"), ""), Values.toDouble(r.get("VALUE")));
        }
        long now = System.currentTimeMillis();
        Metrics.addExporter(metrics, "mysql_global_status_threads_connected", map.get("Threads_connected"), "");
        Metrics.addExporter(metrics, "mysql_global_status_threads_running", map.get("Threads_running"), "");
        Metrics.addExporter(metrics, "mysql_global_status_questions_total", map.get("Questions"), "");
        Metrics.addExporter(metrics, "mysql_global_status_uptime_seconds", map.get("Uptime"), "s");
        Metrics.addExporter(metrics, "mysql_global_status_slow_queries", map.get("Slow_queries"), "");
        Metrics.addExporter(metrics, "mysql_global_status_connections", map.get("Connections"), "");
        CounterTracker.Delta slow = counters.observe(instanceId, "mysql_slow_queries", map.get("Slow_queries"), now);
        Metrics.addExporterIfPresent(metrics, "mysql_slow_queries_delta", slow.delta(), "");
        CounterTracker.Delta q = counters.observe(instanceId, "mysql_questions", map.get("Questions"), now);
        Metrics.addExporterIfPresent(metrics, "mysql_qps", q.ratePerSec() == null ? null : Metrics.round2(q.ratePerSec()), "/s");
        Double req = map.get("Innodb_buffer_pool_read_requests");
        Double rd = map.getOrDefault("Innodb_buffer_pool_reads", 0.0);
        if (req != null && req > 0) {
            double hit = 100 * (1 - (rd == null ? 0 : rd) / req);
            Metrics.addExporter(metrics, "mysql_innodb_buffer_pool_hit_ratio", Metrics.round2(hit), "%");
        }
        Map<String, Object> act = t.one("SELECT COUNT(*) AS C FROM information_schema.PROCESSLIST WHERE COMMAND <> 'Sleep'");
        Map<String, Object> slp = t.one("SELECT COUNT(*) AS C FROM information_schema.PROCESSLIST WHERE COMMAND = 'Sleep'");
        sessions.add(R.map("STATUS", "ACTIVE", "CNT", act == null ? 0 : Values.toLong(act.get("C"), 0)));
        sessions.add(R.map("STATUS", "INACTIVE", "CNT", slp == null ? 0 : Values.toLong(slp.get("C"), 0)));
    }

    private void pgPerformance(TargetDb t, List<Map<String, Object>> metrics, List<Map<String, Object>> sessions) throws SQLException {
        Map<String, Object> row = t.one("SELECT numbackends::float AS numbackends, xact_commit, xact_rollback, blks_read, blks_hit, "
                + "tup_returned, tup_fetched, deadlocks FROM pg_stat_database WHERE datname = current_database()");
        if (row == null) {
            row = new HashMap<>();
        }
        double br = Values.toDouble(row.get("BLKS_READ")) == null ? 0 : Values.toDouble(row.get("BLKS_READ"));
        double bh = Values.toDouble(row.get("BLKS_HIT")) == null ? 0 : Values.toDouble(row.get("BLKS_HIT"));
        Metrics.addExporter(metrics, "pg_stat_database_numbackends", row.get("NUMBACKENDS"), "");
        Metrics.addExporter(metrics, "pg_stat_database_xact_commit", row.get("XACT_COMMIT"), "");
        Metrics.addExporter(metrics, "pg_stat_database_xact_rollback", row.get("XACT_ROLLBACK"), "");
        Metrics.addExporter(metrics, "pg_stat_database_deadlocks", row.get("DEADLOCKS"), "");
        if (br + bh > 0) {
            Metrics.addExporter(metrics, "pg_buffer_cache_hit_ratio", Metrics.round2(100 * bh / (br + bh)), "%");
        }
        Map<String, Object> z;
        try {
            z = t.one("SELECT SUM(CASE WHEN state = 'active' THEN 1 ELSE 0 END)::int AS a, "
                    + "SUM(CASE WHEN state = 'active' THEN 0 ELSE 1 END)::int AS i "
                    + "FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND backend_type = 'client backend'");
        } catch (SQLException e) {
            // PG < 10 / openGauss(磐维) 没有 backend_type 列：退回到 usename 非空近似“客户端会话”
            z = t.one("SELECT SUM(CASE WHEN state = 'active' THEN 1 ELSE 0 END)::int AS a, "
                    + "SUM(CASE WHEN state = 'active' THEN 0 ELSE 1 END)::int AS i "
                    + "FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND usename IS NOT NULL");
        }
        long a = z == null ? 0 : Values.toLong(z.get("A"), 0);
        long i = z == null ? 0 : Values.toLong(z.get("I"), 0);
        Metrics.addExporter(metrics, "pg_stat_activity_active", a, "");
        if (DbType.PANWEI.equals(t.dbType())) {
            // numbackends 只统计当前连接的那个库。历史趋势要的是实例上的全部会话。
            Map<String, Object> all = t.oneQuietly("SELECT COUNT(*)::int AS c FROM pg_stat_activity");
            if (all != null) {
                Metrics.addExporter(metrics, "pg_stat_activity_total", all.get("C"), "");
            }
        }
        sessions.add(R.map("STATUS", "ACTIVE", "CNT", a));
        sessions.add(R.map("STATUS", "INACTIVE", "CNT", i));
    }

    private void damengPerformance(TargetDb t, List<Map<String, Object>> metrics, List<Map<String, Object>> sessions) {
        List<Map<String, Object>> sess = t.queryQuietly("SELECT STATE AS STATUS, COUNT(*) AS CNT FROM V$SESSIONS GROUP BY STATE");
        if (sess == null) {
            sess = t.queryQuietly("SELECT STATUS, COUNT(*) AS CNT FROM V$SESSION WHERE USERNAME IS NOT NULL GROUP BY STATUS");
        }
        if (sess == null) {
            Map<String, Object> c = t.oneQuietly("SELECT COUNT(*) AS CNT FROM V$SESSIONS");
            sess = c == null ? new ArrayList<>() : new ArrayList<>(List.of(R.map("STATUS", "USER_SESS", "CNT", c.get("CNT"))));
        }
        sessions.addAll(sess);
        long total = 0;
        long active = 0;
        for (Map<String, Object> r : sess) {
            long cnt = Values.toLong(r.get("CNT"), 0);
            total += cnt;
            String st = Values.str(r.get("STATUS"), "").toUpperCase();
            if (st.equals("ACTIVE") || st.equals("OPEN")) {
                active += cnt;
            }
        }
        List<Map<String, Object>> m = t.queryQuietly("SELECT METRIC_NAME, VALUE, METRIC_UNIT FROM V$SYSMETRIC WHERE GROUP_ID = 2 "
                + "AND METRIC_NAME IN ('CPU Usage Per Sec','Host CPU Usage Per Sec','Host CPU Utilization (%)','Buffer Cache Hit Ratio',"
                + "'Shared Pool Free %','User Calls Per Sec','Logons Per Sec','Active Sessions','Current Logons Count')");
        if (m != null) {
            for (Map<String, Object> r : m) {
                Metrics.addExporterIfPresent(metrics, Values.str(r.get("METRIC_NAME"), ""), r.get("VALUE"), Values.str(r.get("METRIC_UNIT"), ""));
            }
        } else {
            List<Map<String, Object>> stat = t.queryQuietly("SELECT NAME, VALUE FROM V$SYSSTAT WHERE NAME IN ('buffer cache hit ratio')");
            if (stat != null) {
                for (Map<String, Object> r : stat) {
                    if ("buffer cache hit ratio".equalsIgnoreCase(Values.str(r.get("NAME"), ""))) {
                        Metrics.addExporterIfPresent(metrics, "Buffer Cache Hit Ratio", r.get("VALUE"), "%");
                    }
                }
            }
            // 原逻辑把累计 execute count 标成 "User Calls Per Sec"，数值无意义，已去掉
        }
        if (Metrics.exporterValue(metrics, "Current Logons Count") == null) {
            Metrics.addExporter(metrics, "Current Logons Count", total, "");
        }
        if (Metrics.exporterValue(metrics, "Active Sessions") == null) {
            Metrics.addExporter(metrics, "Active Sessions", active, "");
        }
    }

    private void sqlServerPerformance(TargetDb t, long instanceId, List<Map<String, Object>> metrics,
                                      List<Map<String, Object>> sessions) throws SQLException {
        List<Map<String, Object>> counters0 = t.query("SELECT RTRIM(counter_name) AS counter_name, cntr_value, RTRIM(object_name) AS object_name "
                + "FROM sys.dm_os_performance_counters WHERE counter_name IN ('Buffer cache hit ratio', "
                + "'Buffer cache hit ratio base', 'User Connections', 'Batch Requests/sec', 'Page life expectancy')");
        Double hit = findCounter(counters0, "Buffer cache hit ratio", "Buffer Manager");
        Double hitBase = findCounter(counters0, "Buffer cache hit ratio base", "Buffer Manager");
        Double batches = findCounter(counters0, "Batch Requests/sec", "SQL Statistics");
        CounterTracker.Delta br = counters.observe(instanceId, "mssql_batch_requests", batches, System.currentTimeMillis());
        Metrics.addExporter(metrics, "mssql_user_connections", findCounter(counters0, "User Connections", "General Statistics"), "");
        Metrics.addExporter(metrics, "mssql_batch_requests_per_sec", br.ratePerSec() == null ? null : Metrics.round2(br.ratePerSec()), "/s");
        Metrics.addExporter(metrics, "mssql_batch_requests_total", batches, "");
        Metrics.addExporter(metrics, "mssql_page_life_expectancy", findCounter(counters0, "Page life expectancy", "Buffer Manager"), "s");
        if (hit != null && hitBase != null && hitBase > 0) {
            Metrics.addExporter(metrics, "mssql_buffer_cache_hit_ratio", Metrics.round2(hit / hitBase * 100), "%");
        }
        Map<String, Object> s = t.one("SELECT SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS active_cnt, "
                + "SUM(CASE WHEN status <> 'running' THEN 1 ELSE 0 END) AS inactive_cnt "
                + "FROM sys.dm_exec_sessions WHERE is_user_process = 1");
        long active = s == null ? 0 : Values.toLong(s.get("ACTIVE_CNT"), 0);
        long inactive = s == null ? 0 : Values.toLong(s.get("INACTIVE_CNT"), 0);
        Metrics.addExporter(metrics, "mssql_active_sessions", active, "");
        sessions.add(R.map("STATUS", "ACTIVE", "CNT", active));
        sessions.add(R.map("STATUS", "INACTIVE", "CNT", inactive));
    }

    private static Double findCounter(List<Map<String, Object>> rows, String name, String objectLike) {
        for (Map<String, Object> r : rows) {
            if (name.equalsIgnoreCase(Values.str(r.get("COUNTER_NAME"), ""))
                    && Values.str(r.get("OBJECT_NAME"), "").contains(objectLike)) {
                return Values.toDouble(r.get("CNTR_VALUE"));
            }
        }
        return null;
    }

    // ========================= sysinfo =========================

    public Map<String, Object> sysinfo(long instanceId) throws SQLException {
        CmdbInstance inst = connector.fetch(instanceId);
        try (TargetDb t = connector.open(inst)) {
            switch (inst.dbType()) {
                case DbType.ORACLE -> {
                    return R.map("instance", t.one("SELECT * FROM V$INSTANCE"),
                            "database", t.one("SELECT DBID,NAME,DB_UNIQUE_NAME,OPEN_MODE,LOG_MODE,CREATED,DATABASE_ROLE,PROTECTION_MODE FROM V$DATABASE"));
                }
                case DbType.MYSQL, DbType.GOLDENDB -> {
                    Map<String, Object> v = t.one("SELECT VERSION() AS VERSION, @@hostname AS HOSTNAME, @@port AS PORT, DATABASE() AS CUR_DB");
                    String cur = v == null ? "" : Values.str(v.get("CUR_DB"), "");
                    return genericSysinfo(v == null ? null : v.get("HOSTNAME"), v == null ? null : v.get("VERSION"), cur);
                }
                case DbType.POSTGRESQL, DbType.PANWEI -> {
                    Map<String, Object> v = t.one("SELECT version() AS VERSION, current_database() AS NAME");
                    return genericSysinfo(DbType.PANWEI.equals(inst.dbType()) ? "PanWeiDB" : "PostgreSQL",
                            v == null ? null : v.get("VERSION"), v == null ? "" : Values.str(v.get("NAME"), ""));
                }
                case DbType.DAMENG -> {
                    Map<String, Object> v = t.oneQuietly("SELECT BANNER FROM V$VERSION WHERE ROWNUM<=1");
                    String banner = v == null ? "Dameng" : Values.str(v.get("BANNER"), "Dameng");
                    return genericSysinfo("Dameng", Values.truncate(banner, 500), "");
                }
                case DbType.SQLSERVER -> {
                    Map<String, Object> v = t.one("SELECT @@VERSION AS VERSION, DB_NAME() AS NAME, CAST(SERVERPROPERTY('ServerName') AS NVARCHAR(256)) AS INSTANCE_NAME");
                    return genericSysinfo(v == null ? "SQL Server" : Values.str(v.get("INSTANCE_NAME"), "SQL Server"),
                            v == null ? null : v.get("VERSION"), v == null ? "" : Values.str(v.get("NAME"), ""));
                }
                default -> throw new SQLException("不支持的数据库类型: " + inst.dbType());
            }
        }
    }

    private static Map<String, Object> genericSysinfo(Object instanceName, Object version, String dbName) {
        Map<String, Object> instance = new LinkedHashMap<>();
        instance.put("INSTANCE_NAME", instanceName);
        instance.put("VERSION", version);
        instance.put("STARTUP_TIME", null);
        instance.put("STATUS", "OPEN");
        return R.map("instance", instance, "database", R.map("NAME", dbName, "OPEN_MODE", "READ WRITE", "LOG_MODE", "",
                "DATABASE_ROLE", "PRIMARY", "DB_UNIQUE_NAME", dbName));
    }

    // ========================= tablespaces =========================

    static final String ORACLE_TABLESPACE_SQL = "select tbs_used_info.tablespace_name, tbs_used_info.total_gb, tbs_used_info.used_gb, "
            + "tbs_used_info.FREE_GB, tbs_used_info.used_of_max USED_PCT from ("
            + " select a.tablespace_name, round(a.bytes_alloc/1024/1024/1024, 2) alloc_gb,"
            + " round((a.bytes_alloc - nvl(b.bytes_free, 0))/1024/1024/1024, 2) used_gb,"
            + " round((a.bytes_alloc - nvl(b.bytes_free, 0)) * 100 / DECODE(a.maxbytes, 0, 1, a.maxbytes), 2) used_of_max,"
            + " round((a.maxbytes - a.bytes_alloc + nvl(b.bytes_free, 0))/1024/1024/1024, 2) FREE_GB,"
            + " round(a.maxbytes/1024/1024/1024, 2) total_gb"
            + " from (select f.tablespace_name, sum(f.bytes) bytes_alloc,"
            + "   sum(decode(f.autoextensible, 'YES', greatest(f.maxbytes, f.bytes), 'NO', f.bytes)) maxbytes"
            + "   from dba_data_files f group by tablespace_name) a,"
            + "  (select f.tablespace_name, sum(f.bytes) bytes_free from dba_free_space f group by tablespace_name) b"
            + " where a.tablespace_name = b.tablespace_name(+)) tbs_used_info order by tbs_used_info.used_of_max desc";

    /**
     * 19c / 12c+ 官方口径（现场验证过的适配语句）：
     * DBA_TABLESPACE_USAGE_METRICS 存的是「块数」，必须乘 DBA_TABLESPACES.BLOCK_SIZE 才是字节。
     * 旧实现先查 V$INSTANCE 判断版本，被管账号没字典权限时该查询报 ORA-00942 / 超时，
     * 直接掉到 DBA_DATA_FILES 链路，实例详情页「表空间使用情况」显示「暂无数据」——
     * 现在无条件优先尝试本语句，版本探测不再是前置条件。
     */
    static final String ORACLE_TABLESPACE_19C_SQL = "SELECT t.tablespace_name, "
            + "ROUND(m.tablespace_size * t.block_size / POWER(1024, 3), 2) AS total_gb, "
            + "ROUND(m.used_space * t.block_size / POWER(1024, 3), 2) AS used_gb, "
            + "ROUND((m.tablespace_size - m.used_space) * t.block_size / POWER(1024, 3), 2) AS free_gb, "
            + "ROUND(m.used_percent, 2) AS used_pct "
            + "FROM dba_tablespace_usage_metrics m "
            + "JOIN dba_tablespaces t ON t.tablespace_name = m.tablespace_name "
            + "ORDER BY m.used_percent DESC";

    /** [fix] 原 ORACLE_TABLESPACE_ALL_SQL 把 DBA_ 替换成 ALL_，但 Oracle 根本没有 ALL_DATA_FILES / ALL_FREE_SPACE */
    static final String ORACLE_TABLESPACE_NAMES_SQL = "SELECT tablespace_name, "
            + "CAST(NULL AS NUMBER) AS total_gb, CAST(NULL AS NUMBER) AS used_gb, "
            + "CAST(NULL AS NUMBER) AS free_gb, CAST(NULL AS NUMBER) AS used_pct "
            + "FROM dba_tablespaces ORDER BY tablespace_name";

    static final String ORACLE_TABLESPACE_USER_SQL = "SELECT tablespace_name, "
            + "CAST(NULL AS NUMBER) AS total_gb, CAST(NULL AS NUMBER) AS used_gb, "
            + "CAST(NULL AS NUMBER) AS free_gb, CAST(NULL AS NUMBER) AS used_pct "
            + "FROM user_tablespaces ORDER BY tablespace_name";

    static boolean oracleAtLeast12c(String version) {
        if (version == null || version.isBlank()) {
            return false;
        }
        String[] p = version.trim().split("\\.");
        if (p.length == 0) {
            return false;
        }
        try {
            int major = Integer.parseInt(p[0]);
            if (major > 12) {
                return true;
            }
            if (major == 12 && p.length > 1) {
                return Integer.parseInt(p[1]) >= 1;
            }
            return false;
        } catch (NumberFormatException e) {
            return false;
        }
    }

    /** 逐级尝试，记录每一级的 ORA 错误，失败原因不再被 queryQuietly 吞掉 */
    private static List<Map<String, Object>> tryTablespaceSql(TargetDb t, String sql, String label,
                                                              List<String> failures) {
        try {
            List<Map<String, Object>> rows = t.query(sql);
            if (rows != null && !rows.isEmpty()) {
                return rows;
            }
            failures.add(label + ": 查询成功但无数据");
        } catch (SQLException e) {
            String reason = "ORA-" + e.getErrorCode() + " " + Values.truncate(String.valueOf(e.getMessage()), 160);
            failures.add(label + ": " + reason);
            log.warn("[tablespace] {} 失败：{}", label, reason);
        }
        return null;
    }

    List<Map<String, Object>> oracleTablespaceList(TargetDb t) throws SQLException {
        List<String> failures = new ArrayList<>();
        // 1) 19c 语句优先（用户现场指定）；不依赖 V$INSTANCE
        List<Map<String, Object>> r = tryTablespaceSql(t, ORACLE_TABLESPACE_19C_SQL,
                "DBA_TABLESPACE_USAGE_METRICS(19c)", failures);
        if (r != null) {
            return r;
        }
        // 2) 11g / 低版本经典口径
        r = tryTablespaceSql(t, ORACLE_TABLESPACE_SQL, "DBA_DATA_FILES+DBA_FREE_SPACE", failures);
        if (r != null) {
            return r;
        }
        // 3) 只有字典视图可读时至少列出表空间名（避免出现「暂无数据」却查不出原因）
        r = tryTablespaceSql(t, ORACLE_TABLESPACE_NAMES_SQL, "DBA_TABLESPACES(仅名称)", failures);
        if (r == null) {
            r = tryTablespaceSql(t, ORACLE_TABLESPACE_USER_SQL, "USER_TABLESPACES(仅名称)", failures);
        }
        if (r != null) {
            return r;
        }
        throw new SQLException("无法读取表空间：" + String.join("；", failures)
                + "。请为被管账号授予 SELECT ANY DICTIONARY（或 SELECT_CATALOG_ROLE 并对 "
                + "DBA_TABLESPACE_USAGE_METRICS / DBA_TABLESPACES / DBA_DATA_FILES / DBA_FREE_SPACE 单独授权），"
                + "详见 docs/monitor-target-db-privileges.md");
    }

    /** 供「运行自检」模块逐条验证表空间查询链路，返回每级语句的结果与原始 ORA 错误 */
    public Map<String, Object> oracleTablespaceDiagnostics(long instanceId) {
        Map<String, Object> out = new LinkedHashMap<>();
        CmdbInstance inst = connector.fetch(instanceId);
        out.put("instanceId", instanceId);
        out.put("hostIp", inst.hostIp());
        out.put("dbType", inst.dbType());
        List<Map<String, Object>> probes = new ArrayList<>();
        String[][] candidates = {
                {"19c DBA_TABLESPACE_USAGE_METRICS", ORACLE_TABLESPACE_19C_SQL},
                {"legacy DBA_DATA_FILES/DBA_FREE_SPACE", ORACLE_TABLESPACE_SQL},
                {"DBA_TABLESPACES(仅名称)", ORACLE_TABLESPACE_NAMES_SQL},
                {"USER_TABLESPACES(仅名称)", ORACLE_TABLESPACE_USER_SQL},
        };
        try (TargetDb t = connector.open(inst)) {
            // 版本只用于自检展示，不再作为选择 19c 语句的前置条件
            Map<String, Object> ver = t.oneQuietly("SELECT VERSION FROM V$INSTANCE");
            String v = ver == null ? null : Values.str(ver.get("VERSION"));
            out.put("version", v);
            out.put("is12cPlus", oracleAtLeast12c(v));
            for (String[] c : candidates) {
                Map<String, Object> p = R.map("name", c[0], "sql", c[1]);
                try {
                    List<Map<String, Object>> rows = t.query(c[1]);
                    p.put("ok", true);
                    p.put("rows", rows == null ? 0 : rows.size());
                    p.put("sample", rows == null || rows.isEmpty() ? null : rows.get(0));
                } catch (Exception e) {
                    p.put("ok", false);
                    p.put("rows", 0);
                    p.put("error", Values.truncate(String.valueOf(e.getMessage()), 300));
                }
                probes.add(p);
            }
        } catch (Exception e) {
            out.put("connectError", Values.truncate(String.valueOf(e.getMessage()), 300));
        }
        out.put("probes", probes);
        return out;
    }

    /**
     * 磐维表空间。spcmaxsize 是文本、单位字节；空或非正数表示未设上限。
     * 原先把 pg_database 的库大小同时写入已用和上限，使用率恒为 100%。
     */
    static final String PANWEI_TABLESPACE_SQL = "SELECT t.spcname AS TABLESPACE_NAME, "
            + "CASE WHEN btrim(COALESCE(t.spcmaxsize, '')) ~ '^[0-9]+$' AND btrim(t.spcmaxsize)::numeric > 0 "
            + "THEN ROUND(btrim(t.spcmaxsize)::numeric / 1024 / 1024 / 1024, 2) ELSE NULL END AS TOTAL_GB, "
            + "ROUND(pg_tablespace_size(t.oid) / 1024.0 / 1024 / 1024, 2) AS USED_GB, "
            + "CASE WHEN btrim(COALESCE(t.spcmaxsize, '')) ~ '^[0-9]+$' AND btrim(t.spcmaxsize)::numeric > 0 "
            + "THEN GREATEST(ROUND((btrim(t.spcmaxsize)::numeric - pg_tablespace_size(t.oid)) / 1024 / 1024 / 1024, 2), 0) "
            + "ELSE NULL END AS FREE_GB, "
            + "CASE WHEN btrim(COALESCE(t.spcmaxsize, '')) ~ '^[0-9]+$' AND btrim(t.spcmaxsize)::numeric > 0 "
            + "THEN ROUND(pg_tablespace_size(t.oid) * 100.0 / btrim(t.spcmaxsize)::numeric, 2) ELSE NULL END AS USED_PCT, "
            + "'PERMANENT' AS CONTENTS, 'ONLINE' AS STATUS "
            + "FROM pg_tablespace t ORDER BY pg_tablespace_size(t.oid) DESC";

    /** 旧版本没有 spcmaxsize 列时只给出已用，使用率留空 */
    static final String PANWEI_TABLESPACE_USED_SQL = "SELECT t.spcname AS TABLESPACE_NAME, "
            + "CAST(NULL AS numeric) AS TOTAL_GB, "
            + "ROUND(pg_tablespace_size(t.oid) / 1024.0 / 1024 / 1024, 2) AS USED_GB, "
            + "CAST(NULL AS numeric) AS FREE_GB, CAST(NULL AS numeric) AS USED_PCT, "
            + "'PERMANENT' AS CONTENTS, 'ONLINE' AS STATUS "
            + "FROM pg_tablespace t ORDER BY pg_tablespace_size(t.oid) DESC";

    private List<Map<String, Object>> panweiTablespaces(TargetDb t) throws SQLException {
        List<Map<String, Object>> r = t.queryQuietly(PANWEI_TABLESPACE_SQL);
        if (r != null && !r.isEmpty()) {
            return r;
        }
        r = t.queryQuietly(PANWEI_TABLESPACE_USED_SQL);
        if (r != null && !r.isEmpty()) {
            return r;
        }
        throw new SQLException("无法读取磐维表空间：请确认被管账号可查询 pg_tablespace，并允许执行 pg_tablespace_size");
    }

    public List<Map<String, Object>> tablespaces(long instanceId) throws SQLException {
        CmdbInstance inst = connector.fetch(instanceId);
        try (TargetDb t = connector.open(inst)) {
            return tablespaces(t, inst);
        }
    }

    public List<Map<String, Object>> tablespaces(TargetDb t, CmdbInstance inst) throws SQLException {
        switch (inst.dbType()) {
            case DbType.ORACLE -> {
                return oracleTablespaceList(t);
            }
            case DbType.MYSQL, DbType.GOLDENDB -> {
                return t.query("SELECT table_schema AS TABLESPACE_NAME, ROUND(SUM(data_length+index_length)/1024/1024/1024,2) AS USED_GB, "
                        + "ROUND(SUM(data_length+index_length)/1024/1024/1024,2) AS TOTAL_GB, 0 AS FREE_GB, 100 AS USED_PCT, "
                        + "'PERMANENT' AS CONTENTS, 'ONLINE' AS STATUS FROM information_schema.tables "
                        + "WHERE table_schema NOT IN ('information_schema','mysql','performance_schema','sys') "
                        + "GROUP BY table_schema ORDER BY USED_GB DESC");
            }
            case DbType.POSTGRESQL -> {
                return t.query("SELECT d.datname AS TABLESPACE_NAME, ROUND(pg_database_size(d.oid)/1024/1024/1024.0, 2) AS TOTAL_GB, "
                        + "ROUND(pg_database_size(d.oid)/1024/1024/1024.0, 2) AS USED_GB, 0 AS FREE_GB, 100 AS USED_PCT, "
                        + "'DATABASE' AS CONTENTS, CASE WHEN datallowconn THEN 'ONLINE' ELSE 'OFFLINE' END AS STATUS "
                        + "FROM pg_database d WHERE datname NOT IN ('template0','template1') ORDER BY pg_database_size(d.oid) DESC");
            }
            case DbType.PANWEI -> {
                return panweiTablespaces(t);
            }
            case DbType.DAMENG -> {
                List<Map<String, Object>> r = t.queryQuietly("SELECT ts.NAME AS TABLESPACE_NAME, "
                        + "ROUND(SUM(df.TOTAL_SIZE) * PAGE() / 1024 / 1024 / 1024, 2) AS TOTAL_GB, "
                        + "ROUND(SUM(df.TOTAL_SIZE - df.FREE_SIZE) * PAGE() / 1024 / 1024 / 1024, 2) AS USED_GB, "
                        + "ROUND(SUM(df.FREE_SIZE) * PAGE() / 1024 / 1024 / 1024, 2) AS FREE_GB, "
                        + "CASE WHEN SUM(df.TOTAL_SIZE) > 0 THEN ROUND(SUM(df.TOTAL_SIZE - df.FREE_SIZE) * 100.0 / SUM(df.TOTAL_SIZE), 2) ELSE 0 END AS USED_PCT, "
                        + "ts.TYPE$ AS CONTENTS, ts.STATUS$ AS STATUS FROM V$TABLESPACE ts JOIN V$DATAFILE df ON ts.ID = df.GROUP_ID "
                        + "GROUP BY ts.NAME, ts.TYPE$, ts.STATUS$ ORDER BY USED_PCT DESC");
                if (r != null && !r.isEmpty()) {
                    return r;
                }
                throw new SQLException("无法读取达梦表空间：请确认被管账号可查询 V$TABLESPACE / V$DATAFILE");
            }
            case DbType.SQLSERVER -> {
                // [fix] FILEPROPERTY 只对当前库有效，原 SQL 跨库汇总时其他库 USED 全是 NULL；改为只算当前连接库的文件
                return t.query("SELECT DB_NAME() AS TABLESPACE_NAME, "
                        + "ROUND(SUM(CAST(size AS bigint)) * 8.0 / 1024 / 1024, 2) AS TOTAL_GB, "
                        + "ROUND(SUM(CAST(FILEPROPERTY(name, 'SpaceUsed') AS bigint)) * 8.0 / 1024 / 1024, 2) AS USED_GB, "
                        + "ROUND(SUM(CAST(size AS bigint) - CAST(FILEPROPERTY(name, 'SpaceUsed') AS bigint)) * 8.0 / 1024 / 1024, 2) AS FREE_GB, "
                        + "CASE WHEN SUM(CAST(size AS bigint)) > 0 THEN ROUND(SUM(CAST(FILEPROPERTY(name, 'SpaceUsed') AS bigint)) * 100.0 / SUM(CAST(size AS bigint)), 2) ELSE 0 END AS USED_PCT, "
                        + "'DATABASE' AS CONTENTS, 'ONLINE' AS STATUS FROM sys.database_files WHERE type_desc = 'ROWS'");
            }
            default -> throw new SQLException("不支持的数据库类型: " + inst.dbType());
        }
    }

    // ========================= sessions =========================

    public List<Map<String, Object>> sessions(long instanceId, boolean onlyActive, String status, String username) throws SQLException {
        CmdbInstance inst = connector.fetch(instanceId);
        String safeUser = username == null ? "" : username.replaceAll("[%_]", "").trim();
        String st = status == null ? "" : status.trim();
        try (TargetDb t = connector.open(inst)) {
            switch (inst.dbType()) {
                case DbType.ORACLE -> {
                    return oracleSessions(t, onlyActive, st, safeUser);
                }
                case DbType.MYSQL, DbType.GOLDENDB -> {
                    StringBuilder sql = new StringBuilder("SELECT ID AS SID, '' AS SERIAL_NUM, USER AS USERNAME, HOST AS MACHINE, "
                            + "'PROCESSLIST' AS PROGRAM, COMMAND AS STATUS, TIME AS LAST_CALL_ET, STATE AS WAIT_CLASS, '' AS EVENT, "
                            + "INFO AS SQL_TEXT, ROUND(TIME/60.0,1) AS WAIT_MIN FROM information_schema.PROCESSLIST WHERE 1=1");
                    List<Object> args = new ArrayList<>();
                    if (onlyActive) {
                        sql.append(" AND COMMAND <> 'Sleep'");
                    }
                    if (!st.isEmpty()) {
                        sql.append(" AND COMMAND = ?");
                        args.add(st);
                    }
                    if (!safeUser.isEmpty()) {
                        sql.append(" AND USER LIKE ?");
                        args.add("%" + safeUser + "%");
                    }
                    sql.append(" ORDER BY TIME DESC LIMIT 200");
                    return withSerial(t.query(sql.toString(), args.toArray()), "");
                }
                case DbType.POSTGRESQL -> {
                    return pgSessions(t, false, onlyActive, st, safeUser);
                }
                case DbType.PANWEI -> {
                    return pgSessions(t, true, onlyActive, st, safeUser);
                }
                case DbType.DAMENG -> {
                    List<Map<String, Object>> r = t.queryQuietly("SELECT SESS_ID AS SID, SESS_SEQ AS SERIAL_NUM, USER_NAME AS USERNAME, "
                            + "CLNT_IP AS MACHINE, APPNAME AS PROGRAM, STATE AS STATUS, "
                            + "DATEDIFF(SS, LAST_RECV_TIME, SYSDATE) AS LAST_CALL_ET, '' AS WAIT_CLASS, '' AS EVENT, "
                            + "ROUND(DATEDIFF(SS, LAST_RECV_TIME, SYSDATE)/60.0, 1) AS WAIT_MIN, SQL_TEXT "
                            + "FROM V$SESSIONS" + (onlyActive ? " WHERE STATE = 'ACTIVE'" : "") + " ORDER BY LAST_RECV_TIME DESC");
                    if (r != null) {
                        return withSerial(r.size() > 200 ? r.subList(0, 200) : r, 0);
                    }
                    try {
                        return oracleSessions(t, onlyActive, st, safeUser);
                    } catch (SQLException e) {
                        return new ArrayList<>();
                    }
                }
                case DbType.SQLSERVER -> {
                    StringBuilder sql = new StringBuilder("SELECT TOP 200 s.session_id AS SID, s.session_id AS SERIAL_NUM, s.login_name AS USERNAME, "
                            + "s.host_name AS MACHINE, s.program_name AS PROGRAM, s.status AS STATUS, "
                            + "COALESCE(r.total_elapsed_time, 0) / 1000 AS LAST_CALL_ET, COALESCE(r.wait_type, '') AS WAIT_CLASS, "
                            + "COALESCE(r.wait_type, '') AS EVENT, ROUND(COALESCE(r.total_elapsed_time, 0) / 60000.0, 1) AS WAIT_MIN, "
                            + "LEFT(st.text, 4000) AS SQL_TEXT FROM sys.dm_exec_sessions s "
                            + "LEFT JOIN sys.dm_exec_requests r ON s.session_id = r.session_id "
                            + "OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) st WHERE s.is_user_process = 1");
                    List<Object> args = new ArrayList<>();
                    if (onlyActive) {
                        sql.append(" AND s.status = 'running'");
                    }
                    if (!st.isEmpty()) {
                        sql.append(" AND s.status = ?");
                        args.add(st);
                    }
                    if (!safeUser.isEmpty()) {
                        sql.append(" AND s.login_name LIKE ?");
                        args.add("%" + safeUser + "%");
                    }
                    sql.append(" ORDER BY s.status, r.total_elapsed_time DESC");
                    return withSerial(t.query(sql.toString(), args.toArray()), 0);
                }
                default -> throw new SQLException("不支持的数据库类型: " + inst.dbType());
            }
        }
    }

    /** PostgreSQL 10+：有 wait_event。磐维多数版本没有这两列，也没有 host(inet)。 */
    static final String PG_SESSION_SQL = "SELECT pid AS SID, 0 AS SERIAL_NUM, usename AS USERNAME, host(client_addr) AS MACHINE, "
            + "application_name AS PROGRAM, state AS STATUS, "
            + "COALESCE(EXTRACT(epoch FROM (now() - state_change))::int, 0) AS LAST_CALL_ET, "
            + "wait_event_type AS WAIT_CLASS, wait_event AS EVENT, "
            + "ROUND((EXTRACT(epoch FROM (now() - state_change))/60.0)::numeric, 1) AS WAIT_MIN, "
            + "LEFT(query, 4000) AS SQL_TEXT FROM pg_stat_activity WHERE pid <> pg_backend_pid()";

    /** 只用磐维 pg_stat_activity 上已经存在的列：pid、usename、client_addr、state、state_change、query */
    static final String PANWEI_SESSION_SQL = "SELECT pid AS SID, 0 AS SERIAL_NUM, usename AS USERNAME, CAST(client_addr AS text) AS MACHINE, "
            + "application_name AS PROGRAM, state AS STATUS, "
            + "COALESCE(CAST(EXTRACT(epoch FROM (now() - state_change)) AS int), 0) AS LAST_CALL_ET, "
            + "CAST('' AS text) AS WAIT_CLASS, CAST('' AS text) AS EVENT, "
            + "ROUND(CAST(EXTRACT(epoch FROM (now() - state_change)) / 60.0 AS numeric), 1) AS WAIT_MIN, "
            + "LEFT(query, 4000) AS SQL_TEXT FROM pg_stat_activity WHERE pid <> pg_backend_pid()";

    private List<Map<String, Object>> pgSessions(TargetDb t, boolean panwei, boolean onlyActive, String status, String user) throws SQLException {
        List<Object> args = new ArrayList<>();
        String tail = pgSessionTail(onlyActive, status, user, args);
        if (panwei) {
            return withSerial(t.query(PANWEI_SESSION_SQL + tail, args.toArray()), 0);
        }
        try {
            return withSerial(t.query(PG_SESSION_SQL + tail, args.toArray()), 0);
        } catch (SQLException first) {
            if (!t.connection().getAutoCommit()) {
                t.connection().rollback();
            }
            return withSerial(t.query(PANWEI_SESSION_SQL + tail, args.toArray()), 0);
        }
    }

    private static String pgSessionTail(boolean onlyActive, String status, String user, List<Object> args) {
        StringBuilder sql = new StringBuilder();
        if (onlyActive) {
            sql.append(" AND state = 'active'");
        }
        if (status != null && !status.isEmpty()) {
            sql.append(" AND state = ?");
            args.add(status);
        }
        if (user != null && !user.isEmpty()) {
            sql.append(" AND usename ILIKE ?");
            args.add("%" + user + "%");
        }
        sql.append(" ORDER BY state_change DESC NULLS LAST LIMIT 200");
        return sql.toString();
    }

    private static List<Map<String, Object>> oracleSessions(TargetDb t, boolean onlyActive, String status, String user) throws SQLException {
        StringBuilder where = new StringBuilder("WHERE s.TYPE='USER'");
        List<Object> args = new ArrayList<>();
        if (onlyActive) {
            where.append(" AND s.STATUS='ACTIVE'");
        }
        if (!status.isEmpty()) {
            where.append(" AND s.STATUS=?");
            args.add(status);
        }
        if (!user.isEmpty()) {
            where.append(" AND s.USERNAME LIKE ?");
            args.add("%" + user + "%");
        }
        // 10.2/11g：无 FETCH FIRST；V$SESSION 无 SQL_CHILD_NUMBER 时用 ADDRESS+HASH_VALUE 关联 V$SQL
        return t.query("SELECT SID, SERIAL_NUM, USERNAME, MACHINE, PROGRAM, STATUS, LAST_CALL_ET, WAIT_CLASS, EVENT, WAIT_MIN, SQL_TEXT FROM ("
                + "SELECT s.SID, s.SERIAL# SERIAL_NUM, s.USERNAME, s.MACHINE, s.PROGRAM, s.STATUS, s.LAST_CALL_ET, s.WAIT_CLASS, s.EVENT, "
                + "ROUND(s.LAST_CALL_ET/60,1) WAIT_MIN, q.SQL_TEXT FROM V$SESSION s "
                + "LEFT JOIN V$SQL q ON s.SQL_ADDRESS = q.ADDRESS AND s.SQL_HASH_VALUE = q.HASH_VALUE " + where
                + " ORDER BY s.STATUS, s.LAST_CALL_ET DESC NULLS LAST) WHERE ROWNUM <= 200", args.toArray());
    }

    private static List<Map<String, Object>> withSerial(List<Map<String, Object>> rows, Object def) {
        List<Map<String, Object>> out = new ArrayList<>(rows.size());
        for (Map<String, Object> r : rows) {
            Map<String, Object> m = new LinkedHashMap<>(r);
            Object s = m.get("SERIAL_NUM");
            m.put("SERIAL#", s == null ? def : s);
            out.add(m);
        }
        return out;
    }

    // ========================= waits =========================

    public List<Map<String, Object>> waits(long instanceId) throws SQLException {
        CmdbInstance inst = connector.fetch(instanceId);
        try (TargetDb t = connector.open(inst)) {
            // 11g 不支持 FETCH FIRST；用 ROWNUM 子查询兼容 RAC/单实例
            String oracleSql = "SELECT EVENT, WAIT_CLASS, TOTAL_WAITS, TOTAL_TIMEOUTS, "
                    + "ROUND(TIME_WAITED_MICRO/1000000,2) TIME_WAITED_SEC, "
                    + "ROUND(TIME_WAITED_MICRO/NULLIF(TOTAL_WAITS,0)/1000,2) AVG_WAIT_MS FROM ("
                    + "SELECT EVENT, WAIT_CLASS, TOTAL_WAITS, TOTAL_TIMEOUTS, TIME_WAITED_MICRO FROM V$SYSTEM_EVENT "
                    + "WHERE WAIT_CLASS NOT IN ('Idle','Other') ORDER BY TIME_WAITED_MICRO DESC) WHERE ROWNUM <= 15";
            List<Map<String, Object>> r = switch (inst.dbType()) {
                case DbType.ORACLE -> t.query(oracleSql);
                case DbType.DAMENG -> t.queryQuietly(oracleSql);
                // [fix] AVG_TIMER_WAIT 单位皮秒，原 /1e6 得到的是微秒却标为毫秒
                case DbType.MYSQL, DbType.GOLDENDB -> t.queryQuietly("SELECT EVENT_NAME AS EVENT, 'Wait' AS WAIT_CLASS, COUNT_STAR AS TOTAL_WAITS, "
                        + "0 AS TOTAL_TIMEOUTS, ROUND(SUM_TIMER_WAIT/1000000000000,2) AS TIME_WAITED_SEC, "
                        + "ROUND(AVG_TIMER_WAIT/1000000000,2) AS AVG_WAIT_MS FROM performance_schema.events_waits_summary_global_by_event_name "
                        + "WHERE SUM_TIMER_WAIT > 0 AND EVENT_NAME NOT LIKE 'wait/io/table/sql/handler' ORDER BY SUM_TIMER_WAIT DESC LIMIT 15");
                case DbType.POSTGRESQL, DbType.PANWEI -> t.queryQuietly("SELECT COALESCE(wait_event, '(none)') AS EVENT, "
                        + "COALESCE(wait_event_type, '-') AS WAIT_CLASS, COUNT(*)::bigint AS TOTAL_WAITS, 0::bigint AS TOTAL_TIMEOUTS, "
                        + "0::numeric AS TIME_WAITED_SEC, 0::numeric AS AVG_WAIT_MS FROM pg_stat_activity "
                        + "WHERE pid <> pg_backend_pid() AND wait_event IS NOT NULL GROUP BY wait_event_type, wait_event "
                        + "ORDER BY COUNT(*) DESC LIMIT 15");
                case DbType.SQLSERVER -> t.queryQuietly("SELECT TOP 15 wait_type AS EVENT, '' AS WAIT_CLASS, waiting_tasks_count AS TOTAL_WAITS, "
                        + "0 AS TOTAL_TIMEOUTS, wait_time_ms / 1000.0 AS TIME_WAITED_SEC, "
                        + "CASE WHEN waiting_tasks_count > 0 THEN wait_time_ms * 1.0 / waiting_tasks_count ELSE 0 END AS AVG_WAIT_MS "
                        + "FROM sys.dm_os_wait_stats WHERE wait_type NOT LIKE 'SLEEP%' AND wait_type NOT LIKE 'BROKER%' "
                        + "AND wait_type NOT IN ('LAZYWRITER_SLEEP','SQLTRACE_BUFFER_FLUSH','XE_TIMER_EVENT','XE_DISPATCHER_WAIT',"
                        + "'REQUEST_FOR_DEADLOCK_SEARCH','CHECKPOINT_QUEUE','LOGMGR_QUEUE','WAITFOR','DIRTY_PAGE_POLL',"
                        + "'HADR_FILESTREAM_IOMGR_IOCOMPLETION','SP_SERVER_DIAGNOSTICS_SLEEP') ORDER BY wait_time_ms DESC");
                default -> new ArrayList<>();
            };
            return r == null ? new ArrayList<>() : r;
        }
    }
}
