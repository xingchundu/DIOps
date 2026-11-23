package com.dbops.sqlinsight.optimize;

import com.alibaba.druid.DbType;
import com.dbops.sqlinsight.ast.SqlAstService;
import com.dbops.sqlinsight.ast.TableMetadata;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 规则优化：执行计划分析 / 索引建议 / 等价改写 */
class OptimizeEngineTest {

    static final String ORA_PLAN = """
            Plan hash value: 1234
            ---------------------------------------------------------------------------
            | Id  | Operation          | Name   | Rows  | Bytes | Cost (%CPU)| Time     |
            ---------------------------------------------------------------------------
            |   0 | SELECT STATEMENT   |        |    10 |   500 |   812   (2)| 00:00:01 |
            |*  1 |  TABLE ACCESS FULL | ORDERS |    10 |   500 |   812   (2)| 00:00:01 |
            ---------------------------------------------------------------------------
            """;

    /** 测试用元数据：ORDERS 有 (STATUS) 索引，CREATED_AT 为 DATE，CUST_NO 为字符 */
    static final TableMetadata META = new TableMetadata() {
        @Override
        public Set<String> indexedColumns(String schema, String table) {
            return "ORDERS".equalsIgnoreCase(table) ? Set.of("ID", "STATUS") : Set.of();
        }

        @Override
        public String columnTypeFamily(String schema, String table, String column) {
            return switch (column.toUpperCase()) {
                case "CREATED_AT" -> "DATE";
                case "CUST_NO", "STATUS" -> "CHAR";
                default -> "NUMBER";
            };
        }

        @Override
        public List<List<String>> indexes(String schema, String table) {
            return "ORDERS".equalsIgnoreCase(table) ? List.of(List.of("ID"), List.of("STATUS")) : List.of();
        }

        @Override
        public List<String> columns(String schema, String table) {
            return "ORDERS".equalsIgnoreCase(table) ? List.of("ID", "CUST_NO", "STATUS", "AMOUNT", "CREATED_AT") : null;
        }

        @Override
        public Long rowCount(String schema, String table) {
            return 5_000_000L;
        }

        @Override
        public Boolean notNull(String schema, String table, String column) {
            return column.equalsIgnoreCase("ID") || column.equalsIgnoreCase("ORDER_ID");
        }
    };

    static SqlAstService.SqlAnalysis analyze(String sql) {
        return new SqlAstService().analyze(sql, "ORACLE", "APP");
    }

    @Test
    void planAnalyzer() {
        assertEquals(Set.of("ORDERS"), PlanAnalyzer.fullScanTables(ORA_PLAN, "ORACLE"));
        assertEquals(812.0, PlanAnalyzer.cost(ORA_PLAN, "ORACLE"), 0.01);
        assertEquals("X-001", PlanAnalyzer.analyze(ORA_PLAN, "ORACLE").get(0).code());
        String pg = "Nested Loop  (cost=0.00..1520.50 rows=10 width=8)\n  ->  Seq Scan on orders o  (cost=0.00..1200.00 rows=1 width=8)";
        assertTrue(PlanAnalyzer.fullScanTables(pg, "PANWEI").contains("ORDERS"));
        assertEquals(1520.5, PlanAnalyzer.cost(pg, "POSTGRESQL"), 0.01);
        assertTrue(PlanAnalyzer.analyze(pg, "POSTGRESQL").stream().anyMatch(f -> f.code().equals("X-007")));
        assertTrue(PlanAnalyzer.analyze(null, "ORACLE").isEmpty());
    }

    @Test
    void indexAdviceFollowsEqualityThenRangeAndSkipsCovered() {
        SqlAstService.SqlAnalysis a = analyze("SELECT ID FROM ORDERS WHERE CREATED_AT >= :1 AND CUST_NO = :2 ORDER BY CREATED_AT");
        List<IndexAdvisor.IndexAdvice> adv = IndexAdvisor.advise(a, META, Set.of("ORDERS"), "ORACLE");
        assertFalse(adv.isEmpty());
        IndexAdvisor.IndexAdvice x = adv.get(0);
        assertEquals(List.of("CUST_NO", "CREATED_AT"), x.columns());
        assertNotNull(x.ddl());
        assertTrue(x.ddl().toUpperCase().contains("ONLINE"), x.ddl());
        assertTrue(x.fullScanInPlan());

        // 已有 (STATUS) 索引覆盖 STATUS = ? → 不再建议
        SqlAstService.SqlAnalysis b = analyze("SELECT ID FROM ORDERS WHERE STATUS = 'A'");
        assertTrue(IndexAdvisor.advise(b, META, Set.of(), "ORACLE").stream().noneMatch(i -> i.ddl() != null));
    }

    @Test
    void indexDdlPerDialect() {
        SqlAstService.SqlAnalysis a = new SqlAstService().analyze("SELECT id FROM orders WHERE cust_no = $1", "POSTGRESQL", "public");
        List<IndexAdvisor.IndexAdvice> adv = IndexAdvisor.advise(a, TableMetadata.NONE, Set.of(), "PANWEI");
        assertTrue(adv.stream().anyMatch(i -> i.ddl() != null && i.ddl().toUpperCase().contains("CONCURRENTLY")), String.valueOf(adv));
    }

    static Map<String, RewriteEngine.Rewrite> byCode(RewriteEngine.Result r) {
        return r.rewrites().stream().collect(java.util.stream.Collectors.toMap(RewriteEngine.Rewrite::code, x -> x, (p, q) -> p));
    }

    @Test
    void rewritesApplyEquivalentChanges() {
        RewriteEngine.Result r = RewriteEngine.rewrite("SELECT * FROM ORDERS WHERE TRUNC(CREATED_AT) = DATE '2026-01-01' AND CUST_NO = 123",
                DbType.oracle, "ORACLE", META);
        Map<String, RewriteEngine.Rewrite> m = byCode(r);
        assertTrue(m.get("RW-01").applied());
        assertTrue(m.get("RW-05").applied());
        // 数字→字符会改变匹配结果（'0123' = 123 成立，'0123' = '123' 不成立），只给建议
        assertFalse(m.get("RW-06").applied());
        String s = r.rewrittenSql().toUpperCase();
        assertTrue(s.contains("CUST_NO = 123"), s);
        assertTrue(s.contains("CREATED_AT >="), s);
        assertFalse(s.contains("TRUNC("), s);
        assertFalse(s.contains("*"), s);
    }

    @Test
    void functionRewriteOnlyForDateConstants() {
        // 绑定变量可能带时间部分，TRUNC(col)=:d 与 col∈[:d, :d+1) 不等价 → 只建议
        RewriteEngine.Result bind = RewriteEngine.rewrite("SELECT ID FROM ORDERS WHERE TRUNC(CREATED_AT) = :d", DbType.oracle, "ORACLE", META);
        assertFalse(byCode(bind).get("RW-05").applied());
        assertNull(bind.rewrittenSql());
        // 带时分秒的 TO_DATE 也不改写
        RewriteEngine.Result withTime = RewriteEngine.rewrite(
                "SELECT ID FROM ORDERS WHERE TRUNC(CREATED_AT) = TO_DATE('2026-01-01 10:00:00','YYYY-MM-DD HH24:MI:SS')", DbType.oracle, "ORACLE", META);
        assertFalse(byCode(withTime).get("RW-05").applied());
        RewriteEngine.Result lit = RewriteEngine.rewrite("SELECT ID FROM ORDERS WHERE TRUNC(CREATED_AT) = TO_DATE('2026-01-01','YYYY-MM-DD')",
                DbType.oracle, "ORACLE", META);
        assertTrue(byCode(lit).get("RW-05").applied());
    }

    @Test
    void notInRewrittenOnlyWhenBothSidesNotNull() {
        String sql = "SELECT ID FROM ORDERS o WHERE o.ID NOT IN (SELECT ORDER_ID FROM REFUND) AND o.CUST_NO LIKE '%9' ORDER BY DBMS_RANDOM.VALUE";
        RewriteEngine.Result unknown = RewriteEngine.rewrite(sql, DbType.oracle, "ORACLE", TableMetadata.NONE);
        Map<String, RewriteEngine.Rewrite> m = byCode(unknown);
        assertFalse(m.get("RW-02").applied());
        assertFalse(m.get("RW-07").applied());
        assertTrue(m.containsKey("RW-11"));
        assertNull(unknown.rewrittenSql());

        RewriteEngine.Result known = RewriteEngine.rewrite(sql, DbType.oracle, "ORACLE", META);
        assertTrue(byCode(known).get("RW-02").applied());
        assertTrue(known.rewrittenSql().toUpperCase().contains("NOT EXISTS"), known.rewrittenSql());

        // 子查询列可空 → 不自动改写
        RewriteEngine.Result nullable = RewriteEngine.rewrite("SELECT ID FROM ORDERS o WHERE o.ID NOT IN (SELECT CUST_NO FROM REFUND)",
                DbType.oracle, "ORACLE", META);
        assertFalse(byCode(nullable).get("RW-02").applied());

        RewriteEngine.Result clean = RewriteEngine.rewrite("SELECT ID FROM ORDERS WHERE ID = :1", DbType.oracle, "ORACLE", META);
        assertNull(clean.rewrittenSql());
    }
}
