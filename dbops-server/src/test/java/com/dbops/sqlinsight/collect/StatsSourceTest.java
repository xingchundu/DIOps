package com.dbops.sqlinsight.collect;

import org.junit.jupiter.api.Test;

import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class StatsSourceTest {

    @Test
    void postgresVersionDifferencesResolvedByCandidates() {
        StatsSource.Spec spec = StatsSource.postgres();
        StatsSource.Probe pg13 = StatsSource.resolve(spec, Set.of("USERID", "DBID", "QUERYID", "TOPLEVEL", "QUERY", "DBNAME", "CALLS",
                "TOTAL_EXEC_TIME", "SHARED_BLKS_HIT", "SHARED_BLKS_READ", "ROWS", "TEMP_BLKS_WRITTEN"));
        assertTrue(pg13.ok());
        assertEquals("TOTAL_EXEC_TIME", pg13.counters().get(Counter.ELAPSED_MS).expr());
        assertEquals(4, pg13.ids().size());
        StatsSource.Probe pg12 = StatsSource.resolve(spec, Set.of("USERID", "DBID", "QUERYID", "QUERY", "DBNAME", "CALLS", "TOTAL_TIME", "ROWS"));
        assertTrue(pg12.ok());
        assertEquals("TOTAL_TIME", pg12.counters().get(Counter.ELAPSED_MS).expr());
        assertFalse(pg12.supports(Counter.LOGICAL_READS));
        assertFalse(pg12.supports(Counter.CPU_MS));
        Map<String, Boolean> cap = pg12.capability();
        assertFalse(cap.get("cpu"));
        assertTrue(cap.get("exec"));
    }

    @Test
    void panweiSpillAndScanColumnsAreOptional() {
        Set<String> base = Set.of("UNIQUE_SQL_ID", "USER_ID", "QUERY", "USER_NAME", "N_CALLS", "TOTAL_ELAPSE_TIME", "N_RETURNED_ROWS");
        StatsSource.Probe bare = StatsSource.resolve(StatsSource.panwei(1000), base);
        assertTrue(bare.ok());
        assertFalse(bare.supports(Counter.ROWS_EXAMINED));
        assertFalse(bare.supports(Counter.TMP_DISK));

        StatsSource.Probe full = StatsSource.resolve(StatsSource.panwei(1000), union(base,
                "N_TUPLES_FETCHED", "N_TUPLES_RETURNED", "SORT_SPILL_SIZE", "HASH_SPILL_SIZE"));
        assertTrue(full.supports(Counter.ROWS_EXAMINED));
        assertEquals("N_TUPLES_FETCHED + N_TUPLES_RETURNED", full.counters().get(Counter.ROWS_EXAMINED).expr());
        assertTrue(full.supports(Counter.TMP_DISK));
        assertEquals("SORT_SPILL_SIZE + HASH_SPILL_SIZE", full.counters().get(Counter.TMP_DISK).expr());

        StatsSource.Probe old = StatsSource.resolve(StatsSource.panwei(1000), union(base, "N_TUPLES_FETCHED", "SORT_SPILLED_COUNT"));
        assertEquals("N_TUPLES_FETCHED", old.counters().get(Counter.ROWS_EXAMINED).expr());
        assertEquals("SORT_SPILLED_COUNT", old.counters().get(Counter.TMP_DISK).expr());
    }

    private static Set<String> union(Set<String> base, String... more) {
        java.util.HashSet<String> s = new java.util.HashSet<>(base);
        s.addAll(java.util.List.of(more));
        return s;
    }

    @Test
    void missingCoreColumnsFailProbe() {
        StatsSource.Probe p = StatsSource.resolve(StatsSource.dameng(1), Set.of("SQL_ID", "SQL_TEXT"));
        assertFalse(p.ok());
        assertTrue(p.error().contains("缺少执行次数"));
    }

    /** DM8 实测：V$SQL_STAT 仅有 SEL/DEL/DDL 分类计数与 EXEC_TIME，无 EXEC_TIMES */
    @Test
    void damengDm8SqlStatLayout() {
        Set<String> cols = Set.of("SQL_ID", "SQL_TXT", "EXEC_TIME", "EXEC_CPU", "SEL_SQL_CNT", "DEL_SQL_CNT", "DDL_SQL_CNT",
                "DYN_EXEC_CNT", "HBUF_LOGIC_READ_CNT", "RECYCLE_LOGIC_READ_CNT", "HBUF_PHY_READ_CNT", "VIS_RECS_CNT",
                "PARSE_TIME", "HARD_PARSE_TIME", "IO_WAIT_TIME");
        StatsSource.Probe p = StatsSource.resolve(StatsSource.dameng(1), cols);
        assertTrue(p.ok(), p.error());
        assertEquals("SEL_SQL_CNT + DEL_SQL_CNT + DDL_SQL_CNT", p.counters().get(Counter.EXEC).expr());
        assertEquals("EXEC_TIME", p.counters().get(Counter.ELAPSED_MS).expr());
        assertEquals("EXEC_CPU", p.counters().get(Counter.CPU_MS).expr());
    }

    @Test
    void queryUsesDialectLimitAndActivityFilter() {
        StatsSource.Probe ora = StatsSource.resolve(StatsSource.oracle(), Set.of("SQL_ID", "PLAN_HASH_VALUE", "SQL_TEXT", "PARSING_SCHEMA_NAME",
                "EXECUTIONS", "ELAPSED_TIME", "CPU_TIME", "BUFFER_GETS", "DISK_READS", "ROWS_PROCESSED", "LAST_ACTIVE_TIME", "COMMAND_TYPE"));
        String q = StatsSource.buildQuery(ora, 500);
        assertTrue(q.contains("ROWNUM <= 500"));
        assertTrue(q.contains("LAST_ACTIVE_TIME >= SYSDATE - 2/1440"));
        assertTrue(ora.activityFiltered());
        StatsSource.Probe ms = StatsSource.resolve(StatsSource.sqlserver(), Set.of("QHASH", "PHASH", "DBNAME", "STMT", "EXECS", "ELAPSED_US",
                "CPU_US", "LR", "PR", "ROWS_RET", "LAST_EXEC"));
        assertTrue(StatsSource.buildQuery(ms, 100).startsWith("SELECT TOP 100 "));
        StatsSource.Probe my = StatsSource.resolve(StatsSource.mysql("MYSQL"), Set.of("SCHEMA_NAME", "DIGEST", "DIGEST_TEXT", "COUNT_STAR",
                "SUM_TIMER_WAIT", "SUM_ROWS_EXAMINED", "SUM_ROWS_SENT", "SUM_ERRORS", "SUM_NO_INDEX_USED", "LAST_SEEN"));
        String mq = StatsSource.buildQuery(my, 50);
        assertTrue(mq.endsWith("LIMIT 50"));
        assertEquals("SUM_NO_INDEX_USED", my.counters().get(Counter.NO_INDEX).expr());
    }

    @Test
    void unitConversionAndNativeId() {
        StatsSource.Probe my = StatsSource.resolve(StatsSource.mysql("MYSQL"), Set.of("SCHEMA_NAME", "DIGEST", "DIGEST_TEXT", "COUNT_STAR", "SUM_TIMER_WAIT"));
        SqlCounters c = StatsSource.toCounters(my, Map.of("NID0", "shop", "NID1", "abc123", "TXT", "SELECT 1", "C_EXEC", 10, "C_ELAPSED_MS", 5_000_000_000L));
        assertEquals("shop|abc123", c.nativeId());
        assertEquals(5.0, c.get(Counter.ELAPSED_MS));
        assertTrue(Double.isNaN(c.get(Counter.CPU_MS)));
        assertEquals("NA", c.planHash());
    }
}
