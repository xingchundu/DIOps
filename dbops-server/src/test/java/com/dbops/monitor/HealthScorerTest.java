package com.dbops.monitor;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class HealthScorerTest {

    private static List<Map<String, Object>> metrics(Object... kv) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (int i = 0; i < kv.length; i += 2) {
            Metrics.addExporter(out, (String) kv[i], kv[i + 1], "");
        }
        return out;
    }

    private static List<Map<String, Object>> keyed(Object... kv) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (int i = 0; i < kv.length; i += 2) {
            Metrics.push(out, (String) kv[i], kv[i + 1], "");
        }
        return out;
    }

    private static HealthScorer.Score score(String type, List<Map<String, Object>> exp, List<Map<String, Object>> eng, List<Map<String, Object>> host) {
        return HealthScorer.compute(type, new HealthScorer.Snapshot(exp, eng, host));
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> issues(HealthScorer.Score s) {
        return (List<Map<String, Object>>) s.dimensions().get("issues");
    }

    @Test
    void offlineIsGradeOfflineNotHealthScore() {
        HealthScorer.Score s = HealthScorer.offline("ORA-01017");
        assertEquals(0, s.score());
        assertEquals("OFFLINE", s.grade());
    }

    @Test
    void noProblemsIsHealthyAndMissingDataNotPenalized() {
        // 只采到缓存命中率：未采集的项不扣分（旧版按 50 分计，总分被拉低到 60 多）
        HealthScorer.Score s = score("ORACLE", metrics("Buffer Cache Hit Ratio", 99.5), null, null);
        assertEquals(100, s.score());
        assertEquals("HEALTHY", s.grade());
        assertEquals(1, s.dimensions().get("checked"));
        assertTrue(issues(s).isEmpty());
    }

    @Test
    void singleCriticalCapsAt59() {
        // 其它都好，只有表空间 97%：加权平均会得到 90 分以上，扣分制封顶 59
        HealthScorer.Score s = score("ORACLE", metrics("Buffer Cache Hit Ratio", 99.5, "db_conn_used_pct", 20),
                keyed("oracle_tablespace_max_used_pct", 97, "oracle_instance_up", 1), keyed("host_cpu_used_pct", 10, "host_mem_used_pct", 50));
        assertEquals(59, s.score());
        assertEquals("CRITICAL", s.grade());
        assertEquals("表空间", issues(s).get(0).get("item"));
        assertEquals("CRIT", issues(s).get(0).get("level"));
    }

    @Test
    void warningsDeductAndCapAt89() {
        HealthScorer.Score one = score("MYSQL", metrics("mysql_innodb_buffer_pool_hit_ratio", 93, "db_conn_used_pct", 10), null, null);
        assertEquals(89, one.score());
        assertEquals("ATTENTION", one.grade());
        HealthScorer.Score two = score("GOLDENDB", metrics("mysql_innodb_buffer_pool_hit_ratio", 93, "db_conn_used_pct", 85), null, null);
        assertEquals(80, two.score());
        assertEquals(2, issues(two).size());
    }

    @Test
    void thresholdsAndConnectionRatio() {
        assertEquals("ATTENTION", score("POSTGRESQL", metrics("db_conn_used_pct", 80), null, null).grade());
        assertEquals("HEALTHY", score("POSTGRESQL", metrics("db_conn_used_pct", 79.9), null, null).grade());
        assertEquals("CRITICAL", score("PANWEI", metrics("db_conn_used_pct", 95), null, null).grade());
        // 磐维：复制断开为严重
        HealthScorer.Score pw = score("PANWEI", null, keyed("panwei_replication_not_streaming_count", 1, "panwei_instance_up", 1), null);
        assertEquals("CRITICAL", pw.grade());
        @SuppressWarnings("unchecked")
        Map<String, Object> cats = (Map<String, Object>) pw.dimensions().get("categories");
        assertEquals("CRIT", ((Map<String, Object>) cats.get("availability")).get("status"));
        assertEquals("NA", ((Map<String, Object>) cats.get("capacity")).get("status"));
    }

    @Test
    void keyMetricsForCards() {
        HealthScorer.Score s = score("ORACLE", metrics("Active Sessions", 12, "Current Logons Count", 80, "db_conn_used_pct", 26.7, "db_conn_max", 300,
                "Buffer Cache Hit Ratio", 99.1, "User Calls Per Sec", 1530), keyed("oracle_tablespace_max_used_pct", 71.2), keyed("host_cpu_used_pct", 35));
        @SuppressWarnings("unchecked")
        Map<String, Object> k = (Map<String, Object>) s.dimensions().get("keyMetrics");
        assertEquals(35.0, k.get("cpu"));
        assertEquals(12.0, k.get("active"));
        assertEquals(80.0, k.get("conn"));
        assertEquals(26.7, k.get("connPct"));
        assertEquals(71.2, k.get("tsMax"));
        assertEquals(1530.0, k.get("tps"));
    }

    @Test
    void activeSessionsCountedFromVsessionOn102() {
        assertEquals(3L, ExporterCollector.activeUserSessions(List.of(
                Map.of("STATUS", "ACTIVE", "CNT", 3),
                Map.of("STATUS", "INACTIVE", "CNT", 40))));
        assertEquals(0L, ExporterCollector.activeUserSessions(List.of(Map.of("STATUS", "INACTIVE", "CNT", 8))));
        assertEquals(0L, ExporterCollector.activeUserSessions(null));
    }

    @Test
    void cpuPrefersDatabaseHostOverSshHost() {
        HealthScorer.Score s = score("ORACLE", metrics("Host CPU Utilization (%)", 8.2), null, keyed("host_cpu_used_pct", 56.8));
        @SuppressWarnings("unchecked")
        Map<String, Object> k = (Map<String, Object>) s.dimensions().get("keyMetrics");
        assertEquals(8.2, k.get("cpu"));
        HealthScorer.Score pw = score("PANWEI", null, keyed("panwei_host_cpu_pct", 6.5), keyed("host_cpu_used_pct", 55.2));
        @SuppressWarnings("unchecked")
        Map<String, Object> pk = (Map<String, Object>) pw.dimensions().get("keyMetrics");
        assertEquals(6.5, pk.get("cpu"));
    }

    @Test
    void trendPrefersHostCpuAndOraclePercent() {
        List<Map<String, Object>> m = metrics("Host CPU Usage Per Sec", 350, "Host CPU Utilization (%)", 12.5, "Current Logons Count", 80);
        Double[] t = HealthScorer.trend("ORACLE", m, null);
        assertEquals(12.5, t[0]);
        assertEquals(80.0, t[1]);
        // 库内主机 CPU 已有时，不用 SSH 关联主机（可能是监控机）的采样覆盖
        assertEquals(12.5, HealthScorer.trend("ORACLE", m, 40.0)[0]);
        assertEquals(40.0, HealthScorer.trend("ORACLE", metrics("Current Logons Count", 80), 40.0)[0]);
        assertNull(HealthScorer.trend("POSTGRESQL", metrics("pg_stat_database_numbackends", 0), null)[0]);
    }

    @Test
    void panweiTrendUsesAllSessionsAndDatabaseCpu() {
        List<Map<String, Object>> m = metrics("pg_stat_database_numbackends", 1, "pg_stat_activity_active", 4, "pg_stat_activity_total", 11);
        Double[] idle = HealthScorer.trend("PANWEI", m, null);
        assertNull(idle[0]);
        assertEquals(11.0, idle[1]);
        assertEquals(1.7, HealthScorer.trend("PANWEI", m, 1.7)[0]);
    }
}
