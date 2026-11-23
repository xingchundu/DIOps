package com.dbops.common;

import com.dbops.config.EnvFileLoaderAccess;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ValuesTest {

    @Test
    void numbers() {
        assertEquals(20, Values.toInt("20", 1));
        assertEquals(1, Values.toInt("abc", 1));
        assertNull(Values.toStrictLong("1.5"));
        assertEquals(15L, Values.toStrictLong("15"));
        assertTrue(Values.numEq(new java.math.BigDecimal("3"), "3"));
        assertTrue(Values.truthy("1"));
        assertFalse(Values.truthy("0"));
        assertEquals("?,?,?", Db.placeholders(3));
    }

    @Test
    void envFile() {
        int n = EnvFileLoaderAccess.apply(java.util.List.of("# c", "DBOPS_T1=abc # tail", "export DBOPS_T2=\"x y\"", "BAD"));
        assertEquals(2, n);
        assertEquals("abc", System.getProperty("DBOPS_T1"));
        assertEquals("x y", System.getProperty("DBOPS_T2"));
    }
}
