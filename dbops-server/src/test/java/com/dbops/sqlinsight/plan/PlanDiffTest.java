package com.dbops.sqlinsight.plan;

import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class PlanDiffTest {

    private static final String ORA_OLD = "| Id  | Operation          | Name | Rows |\n|   0 | SELECT STATEMENT   |      |    1 |\n"
            + "|*  1 |  HASH JOIN         |      |    1 |\n|   2 |   TABLE ACCESS FULL| EMP  |   10 |\n|   3 |   TABLE ACCESS FULL| DEPT |    4 |\n";
    private static final String ORA_NEW = "| Id  | Operation                    | Name      | Rows |\n|   0 | SELECT STATEMENT             |           |    1 |\n"
            + "|   1 |  NESTED LOOPS                |           |    1 |\n|   2 |   TABLE ACCESS BY INDEX ROWID| EMP       |   10 |\n"
            + "|*  3 |    INDEX RANGE SCAN          | IDX_EMP_D |   10 |\n|   4 |   TABLE ACCESS FULL          | DEPT      |    4 |\n";

    @Test
    void oracleAccessPathChange() {
        Map<String, Object> r = PlanDiff.compare(ORA_OLD, ORA_NEW);
        assertTrue((Boolean) r.get("parsed"));
        assertTrue((Boolean) r.get("changed"));
        assertEquals(List.of("TABLE ACCESS FULL (EMP)"), r.get("removed"));
        assertTrue(((List<?>) r.get("added")).contains("INDEX RANGE SCAN (IDX_EMP_D)"));
        assertEquals(List.of("HASH JOIN"), r.get("joinRemoved"));
        assertEquals(List.of("NESTED LOOPS"), r.get("joinAdded"));
    }

    @Test
    void identicalPlansAreUnchanged() {
        Map<String, Object> r = PlanDiff.compare(ORA_NEW, ORA_NEW);
        assertFalse((Boolean) r.get("changed"));
    }

    @Test
    void postgresSeqScanToIndexScan() {
        Map<String, Object> r = PlanDiff.compare("Seq Scan on orders  (cost=0..10)", "Index Scan using idx_o on orders  (cost=0.4..8)");
        assertTrue((Boolean) r.get("oldFullScan"));
        assertFalse((Boolean) r.get("newFullScan"));
        assertTrue(String.valueOf(r.get("summary")).contains("消除了全表扫描"));
    }

    @Test
    void mysqlTable() {
        String h = "id | select_type | table | partitions | type | possible_keys | key | rows\n----------------------------------------\n";
        Map<String, Object> r = PlanDiff.compare(h + "1 | SIMPLE | t | NULL | ALL | NULL | NULL | 100\n", h + "1 | SIMPLE | t | NULL | ref | idx | idx | 1\n");
        assertTrue((Boolean) r.get("oldFullScan"));
        assertFalse((Boolean) r.get("newFullScan"));
    }

    @Test
    void unparsableIsNeverReportedAsUnchanged() {
        Map<String, Object> r = PlanDiff.compare("执行计划为空", ORA_NEW);
        assertFalse((Boolean) r.get("parsed"));
        assertFalse((Boolean) r.get("changed"));
        assertTrue(String.valueOf(r.get("summary")).contains("无法解析"));
    }

    @Test
    void retestVerdict() {
        Map<String, Object> before = new HashMap<>(Map.of("AVG_MS", 120.0, "P95_MS", 300.0, "LR", 50000));
        Map<String, Object> after = new HashMap<>(Map.of("AVG_MS", 30.0, "P95_MS", 60.0, "LR", 900, "EXECS", 100, "WINDOWS", 20));
        assertEquals("IMPROVED", RetestVerdict.evaluate(before, after).get("verdict"));
        after.put("AVG_MS", 200.0);
        assertEquals("REGRESSION", RetestVerdict.evaluate(before, after).get("verdict"));
        after.put("AVG_MS", 118.0);
        assertEquals("SIMILAR", RetestVerdict.evaluate(before, after).get("verdict"));
        after.put("EXECS", 2);
        assertEquals("NO_DATA", RetestVerdict.evaluate(before, after).get("verdict"));   // 样本不足不下结论
        assertEquals("NO_DATA", RetestVerdict.evaluate(new HashMap<>(), after).get("verdict"));
    }
}
