package com.dbops.sqlinsight.audit;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class SqlAuditScoringTest {

    @Test
    void scoreAndRiskMatchLegacyCoefficients() {
        List<Map<String, Object>> issues = List.of(SqlAuditService.issue("A", "CRITICAL", "x", null),
                SqlAuditService.issue("B", "WARNING", "y", null), SqlAuditService.issue("C", "INFO", "z", null));
        assertEquals(50, SqlAuditService.score(issues));
        assertEquals("HIGH", SqlAuditService.risk(50));
        assertEquals("LOW", SqlAuditService.risk(90));
        assertEquals("CRITICAL", SqlAuditService.risk(49));
    }

    @Test
    void instanceCheckMergeSameAsLegacy() {
        List<Map<String, Object>> issues = new ArrayList<>();
        List<String> hints = new ArrayList<>(List.of("建议在执行前使用 EXPLAIN 确认执行计划"));
        Map<String, Object> ic = new LinkedHashMap<>();
        ic.put("connected", true);
        ic.put("instanceName", "ora01");
        ic.put("tables", List.of(Map.of("schema", "S", "name", "T1", "exists", false)));
        ic.put("executable", true);
        ic.put("explainOk", true);
        ic.put("fullScanDetected", true);
        SqlAuditService.mergeInstanceCheck(issues, hints, ic);
        assertTrue(issues.stream().anyMatch(i -> "TABLE_NOT_FOUND".equals(i.get("code"))));
        assertTrue(issues.stream().anyMatch(i -> "FULL_TABLE_SCAN".equals(i.get("code"))));
        assertFalse(hints.stream().anyMatch(h -> h.contains("EXPLAIN")));
        assertTrue(hints.get(0).contains("全表扫描"));
        List<Map<String, Object>> i2 = new ArrayList<>();
        SqlAuditService.mergeInstanceCheck(i2, new ArrayList<>(), Map.of("connected", false, "connectionError", "timeout"));
        assertEquals("DB_UNREACHABLE", i2.get(0).get("code"));
    }

    @Test
    void fullScanDetectionPerDialect() {
        assertTrue(ExplainService.detectFullScan("| 2 | TABLE ACCESS FULL | EMP |", "ORACLE"));
        assertTrue(ExplainService.detectFullScan("| 1 | SIMPLE | t | ALL | NULL |", "MYSQL"));
        assertTrue(ExplainService.detectFullScan("Seq Scan on orders  (cost=0.00..1.00)", "PANWEI"));
        assertFalse(ExplainService.detectFullScan("Index Scan using pk on orders", "POSTGRESQL"));
        assertFalse(ExplainService.detectFullScan("|--Table Scan  |--Index Seek", "SQLSERVER"));
        assertEquals("CHAR", TargetMetadata.family("varchar2"));
        assertEquals("NUMBER", TargetMetadata.family("NUMBER"));
        assertEquals("DATE", TargetMetadata.family("timestamp without time zone"));
    }
}
