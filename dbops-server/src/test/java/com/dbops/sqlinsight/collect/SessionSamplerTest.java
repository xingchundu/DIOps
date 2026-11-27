package com.dbops.sqlinsight.collect;

import org.junit.jupiter.api.Test;

import java.sql.SQLException;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class SessionSamplerTest {

    @Test
    void panweiSampleSqlDoesNotRequireWaitEvent() {
        String q = SessionSampler.query("PANWEI").toLowerCase();
        assertFalse(q.contains("a.wait_event"));
        assertFalse(q.contains("wait_event_type"));
        assertTrue(q.contains("pg_stat_activity"));
        assertTrue(q.contains("query_start"));
    }

    @Test
    void postgresqlWaitEventSitsAtTheReportedPosition() {
        String q = SessionSampler.query("POSTGRESQL");
        assertTrue(q.indexOf("a.wait_event") == 153, q);
        assertTrue(SessionSampler.missingWaitEvent(new SQLException(
                "ERROR: column a.wait_event does not exist Position: 154 Where: referenced column: wait_event")));
        assertFalse(SessionSampler.missingWaitEvent(new SQLException("permission denied for view pg_stat_activity")));
    }
}
