package com.dbops.sqlinsight.collect;

import org.junit.jupiter.api.Test;

import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 立即采集慢 SQL：Oracle / 磐维 / 达梦 的查询构造 */
class SlowSqlSourceTest {

    @Test
    void oracleUsesFullTextAndCumulativeThreshold() {
        Set<String> cols = Set.of("SQL_ID", "PLAN_HASH_VALUE", "SQL_TEXT", "SQL_FULLTEXT", "PARSING_SCHEMA_NAME", "EXECUTIONS", "ELAPSED_TIME",
                "CPU_TIME", "BUFFER_GETS", "DISK_READS", "ROWS_PROCESSED", "LAST_ACTIVE_TIME", "COMMAND_TYPE");
        StatsSource.Probe p = StatsSource.resolve(StatsSource.oracle(), cols);
        String q = SlowSqlSource.buildQuery(p, cols, SlowSqlSource.extras("ORACLE", 1000, 1), 50, 1000);
        assertTrue(q.contains("DBMS_LOB.SUBSTR(SQL_FULLTEXT, 2000, 1) AS TXT"), q);
        assertTrue(q.contains("ELAPSED_TIME) >= 1000000 * (EXECUTIONS)"), q);
        assertTrue(q.contains("ROWNUM <= 50"));
        assertTrue(q.contains("LAST_ACTIVE_TIME AS LASTV"));
        // 慢 SQL 看累计值，不加“最近 2 分钟活跃”过滤
        assertFalse(q.contains("SYSDATE - 2/1440"));
    }

    @Test
    void panweiUsesDivisorAndLimit() {
        Set<String> cols = Set.of("UNIQUE_SQL_ID", "USER_ID", "NODE_ID", "QUERY", "USER_NAME", "N_CALLS", "TOTAL_ELAPSE_TIME", "MAX_ELAPSE_TIME",
                "CPU_TIME", "N_BLOCKS_FETCHED", "N_BLOCKS_HIT", "N_RETURNED_ROWS", "LAST_UPDATED");
        StatsSource.Probe p = StatsSource.resolve(StatsSource.panwei(1000), cols);
        String q = SlowSqlSource.buildQuery(p, cols, SlowSqlSource.extras("PANWEI", 1000, 1), 20, 500);
        assertTrue(q.contains("FROM dbe_perf.statement"), q);
        assertTrue(q.contains("TOTAL_ELAPSE_TIME) >= 500000 * (N_CALLS)"), q);
        assertTrue(q.contains("MAX_ELAPSE_TIME AS MAXV, 1000 AS MAXD"), q);
        assertTrue(q.endsWith("LIMIT 20"));
        assertFalse(q.contains("INTERVAL '2 minutes'"));
    }

    @Test
    void damengSqlStatAndLongExec() {
        Set<String> cols = Set.of("SQL_ID", "SQL_TXT", "CURR_SCH", "EXEC_TIMES", "TOTAL_EXEC_TIME", "MAX_EXEC_TIME", "LAST_EXEC_TIME");
        StatsSource.Probe p = StatsSource.resolve(StatsSource.dameng(1), cols);
        String q = SlowSqlSource.buildQuery(p, cols, SlowSqlSource.extras("DAMENG", 1000, 1), 10, 1000);
        assertTrue(q.contains("FROM V$SQL_STAT"), q);
        assertTrue(q.contains("TOTAL_EXEC_TIME) >= 1000 * (EXEC_TIMES)"), q);
        assertTrue(q.contains("ROWNUM <= 10"));

        String le = SlowSqlSource.damengLongExecQuery(Set.of("SQL_ID", "SQL_TEXT", "EXEC_TIME", "FINISH_TIME"), 10, 2000, 1);
        assertTrue(le.contains("FROM V$LONG_EXEC_SQLS WHERE EXEC_TIME >= 2000"), le);
        assertTrue(le.contains("GROUP BY SUBSTR(SQL_TEXT, 1, 2000)"));
        assertTrue(le.contains("MAX(FINISH_TIME) AS LASTV"));
        assertNull(SlowSqlSource.damengLongExecQuery(Set.of("SQL_ID"), 10, 2000, 1));
        assertEquals(-1, le.indexOf("NULLIF"));
    }
}
