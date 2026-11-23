package com.dbops.sqlinsight.ast;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 真实 Druid 解析器：指纹归一化 + 危险语句识别 */
class SqlAstServiceTest {

    private final SqlAstService ast = new SqlAstService();

    @Test
    void literalsAndInListsShareFingerprint() {
        SqlAstService.SqlAnalysis a = ast.analyze("select * from emp where empno = 7369 and ename in ('A','B')", "ORACLE", "scott");
        SqlAstService.SqlAnalysis b = ast.analyze("SELECT *  FROM emp WHERE empno=1 AND ename IN ('X','Y','Z')", "ORACLE", "SCOTT");
        assertTrue(a.parsed());
        assertEquals(a.fingerprint(), b.fingerprint());
        assertEquals("SELECT", a.stmtType());
    }

    @Test
    void bindVariablesNormalizeLikeLiterals() {
        String a = ast.analyze("select name from t where id = :1", "ORACLE", null).fingerprint();
        String b = ast.analyze("select name from t where id = 42", "ORACLE", null).fingerprint();
        assertEquals(a, b);
        String pg1 = ast.analyze("select name from t where id = $1", "POSTGRESQL", null).fingerprint();
        String pg2 = ast.analyze("select name from t where id = 5", "POSTGRESQL", null).fingerprint();
        assertEquals(pg1, pg2);
    }

    @Test
    void schemaAndDialectAreSeparateAssets() {
        String a = ast.analyze("select 1 from t where x = 1", "ORACLE", "A").fingerprint();
        String b = ast.analyze("select 1 from t where x = 1", "ORACLE", "B").fingerprint();
        String c = ast.analyze("select 1 from t where x = 1", "MYSQL", "A").fingerprint();
        assertFalse(a.equals(b));
        assertFalse(a.equals(c));
        // GoldenDB 与 MySQL 同族
        assertEquals(ast.analyze("select 1 from t", "MYSQL", null).fingerprint(), ast.analyze("select 1 from t", "GOLDENDB", null).fingerprint());
    }

    @Test
    void mysqlDigestTextParses() {
        SqlAstService.SqlAnalysis a = ast.analyze("SELECT `a` FROM `t1` WHERE `id` IN (...) AND `x` = ?", "MYSQL", "db1");
        assertTrue(a.parsed());
        assertEquals(a.fingerprint(), ast.analyze("SELECT a FROM t1 WHERE id IN (1,2,3) AND x = 'q'", "MYSQL", "db1").fingerprint());
    }

    @Test
    void parseFailureFallsBackToTextNormalization() {
        SqlAstService.SqlAnalysis a = ast.analyze("select id from t1 where id = 5 and garbage(((", "ORACLE", null);
        SqlAstService.SqlAnalysis b = ast.analyze("select id from t1 where id = 6 and garbage(((", "ORACLE", null);
        assertFalse(a.parsed());
        assertEquals(a.fingerprint(), b.fingerprint());
    }

    @Test
    void dangerousDetectionCannotBeBypassed() {
        assertNull(ast.dangerousType("select * from t", "ORACLE"));
        assertEquals("DDL", ast.dangerousType("/* harmless */ DROP TABLE t", "ORACLE"));
        assertEquals("DELETE", ast.dangerousType("select 1 from dual; delete from t", "ORACLE"));
        assertEquals("DELETE", ast.dangerousType("WITH x AS (SELECT id FROM a) DELETE FROM b WHERE id IN (SELECT id FROM x)", "POSTGRESQL"));
        assertEquals("UNKNOWN", ast.dangerousType("BEGIN delete_all; END;", "ORACLE"));
        assertEquals("DCL", ast.dangerousType("grant select on t to u", "MYSQL"));
        assertEquals("DDL", ast.dangerousType("truncate table t", "MYSQL"));
    }

    @Test
    void classifyKeepsEveryStatement() {
        List<String> t = ast.classify("select 1; update t set a = 1 where id = 2", "MYSQL");
        assertEquals(2, t.size());
        assertEquals("UPDATE", t.get(1));
    }

    @Test
    void tablesExtracted() {
        SqlAstService.SqlAnalysis a = ast.analyze("select e.ename from emp e join dept d on e.deptno = d.deptno", "ORACLE", null);
        assertEquals(2, a.tables().size());
    }
}
