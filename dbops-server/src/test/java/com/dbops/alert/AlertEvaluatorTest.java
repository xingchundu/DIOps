package com.dbops.alert;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class AlertEvaluatorTest {

    @Test
    void compareOperators() {
        assertTrue(AlertEvaluator.compare("gt", 91.0, 90));
        assertFalse(AlertEvaluator.compare("gt", 90.0, "90"));
        assertTrue(AlertEvaluator.compare("gte", 90.0, "90"));
        assertTrue(AlertEvaluator.compare("eq", 0.1 + 0.2, 0.3)); // Node 版 === 比较为 false
        assertFalse(AlertEvaluator.compare("lt", null, 1));
        assertFalse(AlertEvaluator.compare("bogus", 1.0, 1));
    }

    @Test
    void metricMapIncludesExporterAndReachability() {
        Map<String, Double> m = AlertEvaluator.metricMap(
                List.of(Map.of("key", "host_cpu_used_pct", "value", 77.5), Map.of("key", "_host_skip", "value", 0)),
                List.of(Map.of("METRIC_NAME", "mysql_global_status_threads_connected", "VALUE", 42),
                        Map.of("METRIC_NAME", "Buffer Cache Hit Ratio", "VALUE", 99.1)),
                true, 88, "MYSQL");
        assertEquals(77.5, m.get("host_cpu_used_pct"));
        assertEquals(42.0, m.get("mysql_global_status_threads_connected"));
        assertEquals(99.1, m.get("oracle_buffer_cache_hit_pct"));
        assertEquals(1.0, m.get("db_reachable"));
        assertEquals(88.0, m.get("health_score"));
        assertNull(m.get("_host_skip"));
        // 种子规则使用的指标名
        assertEquals(99.1, m.get("oracle_buffer_cache_hit"));
        Map<String, Double> ora = AlertEvaluator.metricMap(List.of(Map.of("key", "oracle_tablespace_max_used_pct", "value", 85)),
                List.of(Map.of("METRIC_NAME", "Active Sessions", "VALUE", 230)), true, 70, "ORACLE");
        assertEquals(85.0, ora.get("tablespace_usage_pct"));
        assertEquals(230.0, ora.get("db_active_sessions"));

        Map<String, Double> down = AlertEvaluator.metricMap(null, null, false, 0, "ORACLE");
        assertEquals(0.0, down.get("db_reachable"));
        assertEquals(0.0, down.get("oracle_instance_up"));
    }

    @Test
    void severityRankAndCsv() {
        assertTrue(AlertPolicyService.severityRank("P1") < AlertPolicyService.severityRank("P3"));
        assertEquals(List.of("P1", "P2"), AlertPolicyService.splitCsv(" P1, P2 ,"));
        assertEquals(List.of(3L, 5L), AlertPolicyService.parseIds("[3,\"5\",null]"));
        assertEquals(List.of(), AlertPolicyService.parseIds("not json"));
    }
}
