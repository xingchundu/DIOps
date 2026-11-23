package com.dbops.sqlinsight.ast;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class StaticRuleEngineTest {

    private final SqlAstService ast = new SqlAstService();

    private List<String> codes(String sql, String db) {
        return codes(sql, db, TableMetadata.NONE);
    }

    private List<String> codes(String sql, String db, TableMetadata md) {
        return StaticRuleEngine.analyze(ast.analyze(sql, db, null), StaticRuleEngine.RuleView.DEFAULTS, md)
                .findings().stream().map(Finding::code).toList();
    }

    @Test
    void oracleUpdateWithoutWhereNoStackOverflow() {
        assertTrue(codes("update emp set sal = sal * 1.1", "ORACLE").contains("S-001"));
        assertFalse(codes("update emp set sal = 1 where empno = 1", "ORACLE").contains("S-001"));
    }

    @Test
    void subqueryWhereDoesNotHideMissingOuterWhere() {
        // 原正则 (DELETE|UPDATE)\s+\w+(?![\s\S]*WHERE) 会被子查询里的 WHERE 骗过
        assertTrue(codes("update t set a = (select max(b) from t2 where t2.id = 1)", "MYSQL").contains("S-001"));
    }

    @Test
    void cartesianDetection() {
        assertTrue(codes("select * from emp e, dept d where e.sal > 100", "ORACLE").contains("S-002"));
        assertFalse(codes("select e.ename from emp e, dept d where e.deptno = d.deptno(+) and d.loc = 'X'", "ORACLE").contains("S-002"));
        assertFalse(codes("select * from t1 t, t2 where t.id = t2.id", "PANWEI").contains("S-002"));
        assertTrue(codes("select a.x from a join b on a.id = b.aid, c where c.k = 1", "POSTGRESQL").contains("S-002"));
    }

    @Test
    void selectStarButNotInsideExists() {
        assertTrue(codes("select * from t", "MYSQL").contains("S-003"));
        assertFalse(codes("select id from t where exists (select * from t2 where t2.id = t.id)", "MYSQL").contains("S-003"));
    }

    @Test
    void leadingWildcardIncludingConcat() {
        assertTrue(codes("select id from t where name like '%abc'", "MYSQL").contains("S-004"));
        assertTrue(codes("select id from t where name like concat('%', ?)", "MYSQL").contains("S-004"));
        assertTrue(codes("select id from t where name like '%' || :x", "ORACLE").contains("S-004"));
        assertFalse(codes("select id from t where name like 'abc%'", "MYSQL").contains("S-004"));
    }

    @Test
    void functionOnIndexedColumnUsesMetadata() {
        TableMetadata md = new TableMetadata() {
            @Override
            public Set<String> indexedColumns(String schema, String table) {
                return Set.of("ENAME");
            }

            @Override
            public String columnTypeFamily(String schema, String table, String column) {
                return "PHONE".equals(column) ? "CHAR" : "NUMBER";
            }
        };
        StaticRuleEngine.Result r = StaticRuleEngine.analyze(
                ast.analyze("select ename from emp where upper(ename) = 'A' and phone = 13800000000", "ORACLE", null),
                StaticRuleEngine.RuleView.DEFAULTS, md);
        assertTrue(r.findings().stream().anyMatch(f -> f.code().equals("S-005") && f.severity().equals("WARNING")));
        assertTrue(r.findings().stream().anyMatch(f -> f.code().equals("S-006")));
    }

    @Test
    void implicitConversionSkippedWithoutMetadata() {
        StaticRuleEngine.Result r = StaticRuleEngine.analyze(ast.analyze("select 1 from emp where phone = 1380", "ORACLE", null),
                StaticRuleEngine.RuleView.DEFAULTS, TableMetadata.NONE);
        assertFalse(r.findings().stream().anyMatch(f -> f.code().equals("S-006")));
        assertTrue(r.skipped().stream().anyMatch(s -> s.code().equals("S-006")));
    }

    @Test
    void policiesAndHints() {
        assertTrue(codes("drop table emp", "ORACLE").contains("D-001"));
        assertTrue(codes("truncate table emp", "MYSQL").contains("D-002"));
        assertTrue(codes("alter table t add column c int not null", "MYSQL").contains("D-003"));
        assertTrue(codes("select 1 from dual where deptno not in (select deptno from dept)", "ORACLE").contains("H-001"));
        assertTrue(codes("select id from t where a = 1 limit 10", "MYSQL").contains("H-002"));
        assertTrue(codes("select id from t order by id limit 20000, 10", "MYSQL").contains("H-003"));
    }

    @Test
    void longInList() {
        StringBuilder sb = new StringBuilder("select 1 from t where id in (");
        for (int i = 0; i < 1000; i++) {
            sb.append(i == 0 ? "" : ",").append(i);
        }
        sb.append(")");
        assertTrue(codes(sb.toString(), "MYSQL").contains("S-007"));
    }

    @Test
    void unparsedSqlIsMarkedSkippedNotPassed() {
        StaticRuleEngine.Result r = StaticRuleEngine.analyze(ast.analyze("selec broken ((", "ORACLE", null),
                StaticRuleEngine.RuleView.DEFAULTS, null);
        assertEquals(0, r.findings().size());
        assertEquals(1, r.skipped().size());
    }

    @Test
    void ruleViewDisablesAndOverridesSeverity() {
        StaticRuleEngine.RuleView v = new StaticRuleEngine.RuleView() {
            @Override
            public boolean enabled(String code) {
                return !"S-003".equals(code);
            }

            @Override
            public String severity(String code, String def) {
                return "S-004".equals(code) ? "CRITICAL" : def;
            }

            @Override
            public double param(String code, String key, double def) {
                return "S-007".equals(code) ? 3 : def;
            }
        };
        List<Finding> f = StaticRuleEngine.analyze(ast.analyze("select * from t where n like '%a' and id in (1,2,3)", "MYSQL", null), v, null).findings();
        assertFalse(f.stream().anyMatch(x -> x.code().equals("S-003")));
        assertTrue(f.stream().anyMatch(x -> x.code().equals("S-004") && x.severity().equals("CRITICAL")));
        assertTrue(f.stream().anyMatch(x -> x.code().equals("S-007")));
    }
}
