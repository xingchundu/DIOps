package com.dbops.sqlinsight.optimize;

import com.alibaba.druid.sql.ast.SQLExpr;
import com.alibaba.druid.sql.ast.SQLOrderBy;
import com.alibaba.druid.sql.ast.SQLStatement;
import com.alibaba.druid.sql.ast.expr.SQLBetweenExpr;
import com.alibaba.druid.sql.ast.expr.SQLBinaryOpExpr;
import com.alibaba.druid.sql.ast.expr.SQLBinaryOperator;
import com.alibaba.druid.sql.ast.expr.SQLExistsExpr;
import com.alibaba.druid.sql.ast.expr.SQLInListExpr;
import com.alibaba.druid.sql.ast.expr.SQLInSubQueryExpr;
import com.alibaba.druid.sql.ast.expr.SQLQueryExpr;
import com.alibaba.druid.sql.ast.statement.SQLDeleteStatement;
import com.alibaba.druid.sql.ast.statement.SQLSelect;
import com.alibaba.druid.sql.ast.statement.SQLSelectOrderByItem;
import com.alibaba.druid.sql.ast.statement.SQLSelectQuery;
import com.alibaba.druid.sql.ast.statement.SQLSelectQueryBlock;
import com.alibaba.druid.sql.ast.statement.SQLSelectStatement;
import com.alibaba.druid.sql.ast.statement.SQLSubqueryTableSource;
import com.alibaba.druid.sql.ast.statement.SQLTableSource;
import com.alibaba.druid.sql.ast.statement.SQLUnionQuery;
import com.alibaba.druid.sql.ast.statement.SQLUpdateStatement;
import com.dbops.monitor.DbType;
import com.dbops.sqlinsight.ast.SqlAstService;
import com.dbops.sqlinsight.ast.StaticRuleEngine;
import com.dbops.sqlinsight.ast.TableMetadata;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * 索引建议（规则）：从 AST 取各表的等值过滤列、连接列、范围列、排序列，按“等值 → 范围 → 排序”组成候选复合索引；
 * 有目标实例时对照现有索引（前导列）判断是否已覆盖，并参考统计行数（小表不建议）与执行计划（全表扫描的表优先）。
 * 只给建议和 DDL，不自动执行。
 */
public final class IndexAdvisor {

    public record IndexAdvice(String schema, String table, List<String> columns, String ddl, String reason,
                              List<List<String>> existing, Boolean covered, Long rows, String confidence, boolean fullScanInPlan) {
    }

    /** 单表的谓词收集 */
    static final class Cols {
        final Set<String> eq = new LinkedHashSet<>();
        final Set<String> join = new LinkedHashSet<>();
        final Set<String> range = new LinkedHashSet<>();
        final Set<String> sort = new LinkedHashSet<>();
    }

    private IndexAdvisor() {
    }

    public static List<IndexAdvice> advise(SqlAstService.SqlAnalysis a, TableMetadata meta, Set<String> fullScanTables, String platformType) {
        List<IndexAdvice> out = new ArrayList<>();
        if (a == null || !a.parsed()) {
            return out;
        }
        TableMetadata md = meta == null ? TableMetadata.NONE : meta;
        Map<StaticRuleEngine.TableRef, Cols> byTable = new LinkedHashMap<>();
        for (SQLStatement st : a.statements()) {
            if (st instanceof SQLSelectStatement s) {
                select(s.getSelect(), byTable, md);
            } else if (st instanceof SQLUpdateStatement u) {
                block(u.getTableSource(), one(u.getWhere()), null, byTable, md);
            } else if (st instanceof SQLDeleteStatement d) {
                block(d.getTableSource(), one(d.getWhere()), null, byTable, md);
            }
        }
        Set<String> fullScan = fullScanTables == null ? Set.of() : fullScanTables;
        for (Map.Entry<StaticRuleEngine.TableRef, Cols> e : byTable.entrySet()) {
            StaticRuleEngine.TableRef t = e.getKey();
            Cols c = e.getValue();
            List<String> cand = new ArrayList<>(c.eq);
            for (String j : c.join) {
                if (!cand.contains(j)) {
                    cand.add(j);
                }
            }
            String range = c.range.stream().filter(r -> !cand.contains(r)).findFirst().orElse(null);
            if (range != null) {
                cand.add(range);
            } else if (!c.sort.isEmpty()) {
                for (String s : c.sort) {
                    if (!cand.contains(s)) {
                        cand.add(s);
                    }
                }
            }
            if (cand.isEmpty() || c.eq.isEmpty() && c.join.isEmpty() && range == null) {
                continue;
            }
            List<String> cols = cand.subList(0, Math.min(4, cand.size()));
            List<List<String>> existing = md.indexes(t.schema(), t.table());
            Boolean covered = existing == null ? null : covered(existing, new LinkedHashSet<>(c.eq.isEmpty() ? c.join : c.eq), range, cols);
            Long rows = md.rowCount(t.schema(), t.table());
            boolean inPlan = fullScan.contains(t.table());
            if (Boolean.TRUE.equals(covered) && !inPlan) {
                continue;     // 已有可用索引且计划没有全表扫描：不提示
            }
            StringBuilder why = new StringBuilder();
            if (!c.eq.isEmpty()) {
                why.append("等值过滤 ").append(String.join(", ", c.eq)).append("；");
            }
            if (!c.join.isEmpty()) {
                why.append("连接列 ").append(String.join(", ", c.join)).append("；");
            }
            if (range != null) {
                why.append("范围条件 ").append(range).append("；");
            } else if (!c.sort.isEmpty()) {
                why.append("排序 ").append(String.join(", ", c.sort)).append("（让索引提供顺序，避免排序）；");
            }
            if (inPlan) {
                why.append("执行计划对该表全表扫描；");
            }
            String confidence;
            if (rows != null && rows < 1000) {
                confidence = "LOW";
                why.append("统计行数约 ").append(rows).append("，小表全表扫描通常更快，可不建；");
            } else if (Boolean.TRUE.equals(covered)) {
                confidence = "LOW";
                why.append("已有索引覆盖前导列，但计划仍为全表扫描：检查统计信息、隐式转换或函数包裹；");
            } else if (inPlan) {
                confidence = "HIGH";
            } else if (covered == null) {
                confidence = "MEDIUM";
                why.append("未连接目标实例，无法确认是否已有索引；");
            } else {
                confidence = "MEDIUM";
            }
            out.add(new IndexAdvice(t.schema(), t.table(), new ArrayList<>(cols), ddl(platformType, t, cols), why.toString(),
                    existing == null ? List.of() : existing, covered, rows, confidence, inPlan));
        }
        // 计划里全表扫描、但 SQL 没有可用过滤条件的表：提示过滤条件而不是索引
        for (String ft : fullScan) {
            boolean has = out.stream().anyMatch(x -> x.table().equals(ft)) || byTable.keySet().stream().anyMatch(k -> k.table().equals(ft));
            if (!has) {
                out.add(new IndexAdvice(null, ft, List.of(), null, "执行计划对该表全表扫描，但 SQL 中没有针对该表的可用过滤/连接条件：先确认是否缺少过滤条件",
                        List.of(), null, md.rowCount(null, ft), "MEDIUM", true));
            }
        }
        return out;
    }

    /** 已有索引的前导列（集合）覆盖等值列，且（有范围列时）紧随其后的是范围列 */
    static boolean covered(List<List<String>> existing, Set<String> eq, String range, List<String> cand) {
        for (List<String> idx : existing) {
            if (idx.isEmpty()) {
                continue;
            }
            if (eq.isEmpty()) {
                if (range != null && idx.get(0).equals(range) || range == null && !cand.isEmpty() && idx.get(0).equals(cand.get(0))) {
                    return true;
                }
                continue;
            }
            if (idx.size() < eq.size()) {
                continue;
            }
            if (new HashSet<>(idx.subList(0, eq.size())).equals(eq)) {
                if (range == null || idx.size() > eq.size() && idx.get(eq.size()).equals(range) || idx.size() == eq.size()) {
                    return true;
                }
            }
        }
        return false;
    }

    static String ddl(String platformType, StaticRuleEngine.TableRef t, List<String> cols) {
        String table = t.schema() == null ? t.table() : t.schema() + "." + t.table();
        String name = ("IDX_" + t.table() + "_" + String.join("_", cols)).replaceAll("[^A-Z0-9_]", "");
        if (name.length() > 30) {
            name = name.substring(0, 30);
        }
        String list = String.join(", ", cols);
        return switch (DbType.normalize(platformType)) {
            case DbType.ORACLE -> "CREATE INDEX " + name + " ON " + table + " (" + list + ") ONLINE";
            case DbType.POSTGRESQL, DbType.PANWEI -> "CREATE INDEX CONCURRENTLY " + name.toLowerCase(Locale.ROOT) + " ON "
                    + table.toLowerCase(Locale.ROOT) + " (" + list.toLowerCase(Locale.ROOT) + ")";
            case DbType.MYSQL, DbType.GOLDENDB -> "ALTER TABLE " + table.toLowerCase(Locale.ROOT) + " ADD INDEX " + name.toLowerCase(Locale.ROOT)
                    + " (" + list.toLowerCase(Locale.ROOT) + "), ALGORITHM=INPLACE, LOCK=NONE";
            default -> "CREATE INDEX " + name + " ON " + table + " (" + list + ")";
        };
    }

    // ------------------------------------------------------------------ AST 收集

    private static void select(SQLSelect s, Map<StaticRuleEngine.TableRef, Cols> byTable, TableMetadata md) {
        if (s == null) {
            return;
        }
        query(s.getQuery(), s.getOrderBy(), byTable, md);
    }

    private static void query(SQLSelectQuery q, SQLOrderBy outerOrder, Map<StaticRuleEngine.TableRef, Cols> byTable, TableMetadata md) {
        if (q instanceof SQLSelectQueryBlock b) {
            SQLOrderBy ob = b.getOrderBy() != null ? b.getOrderBy() : outerOrder;
            List<SQLExpr> conds = new ArrayList<>();
            StaticRuleEngine.collectJoinConditions(b.getFrom(), conds);
            if (b.getWhere() != null) {
                conds.add(0, b.getWhere());
            }
            block(b.getFrom(), conds, ob, byTable, md);
            sub(b.getFrom(), byTable, md);
            subExpr(b.getWhere(), byTable, md);
        } else if (q instanceof SQLUnionQuery u) {
            for (SQLSelectQuery r : u.getRelations()) {
                query(r, null, byTable, md);
            }
        }
    }

    /** 不新建 AND 节点（新建会改写原 AST 的 parent 指针） */
    private static List<SQLExpr> one(SQLExpr e) {
        return e == null ? List.of() : List.of(e);
    }

    private static void sub(SQLTableSource ts, Map<StaticRuleEngine.TableRef, Cols> byTable, TableMetadata md) {
        if (ts instanceof SQLSubqueryTableSource s) {
            select(s.getSelect(), byTable, md);
        } else if (ts instanceof com.alibaba.druid.sql.ast.statement.SQLJoinTableSource j) {
            sub(j.getLeft(), byTable, md);
            sub(j.getRight(), byTable, md);
        }
    }

    /** WHERE 中的子查询（IN / EXISTS / 标量）也给建议 */
    private static void subExpr(SQLExpr e, Map<StaticRuleEngine.TableRef, Cols> byTable, TableMetadata md) {
        if (e instanceof SQLBinaryOpExpr b) {
            subExpr(b.getLeft(), byTable, md);
            subExpr(b.getRight(), byTable, md);
        } else if (e instanceof SQLInSubQueryExpr in) {
            select(in.getSubQuery(), byTable, md);
        } else if (e instanceof SQLExistsExpr ex) {
            select(ex.getSubQuery(), byTable, md);
        } else if (e instanceof SQLQueryExpr q) {
            select(q.getSubQuery(), byTable, md);
        }
    }

    static void block(SQLTableSource from, List<SQLExpr> conds, SQLOrderBy orderBy, Map<StaticRuleEngine.TableRef, Cols> byTable, TableMetadata md) {
        Map<String, StaticRuleEngine.TableRef> aliases = new HashMap<>();
        List<String> sources = new ArrayList<>();
        StaticRuleEngine.collectSources(from, aliases, sources);
        if (sources.isEmpty()) {
            return;
        }
        for (SQLExpr where : conds) {
            for (SQLExpr term : andTerms(where)) {
                term(term, aliases, sources, byTable, md);
            }
        }
        if (orderBy != null && orderBy.getItems() != null) {
            StaticRuleEngine.TableRef only = null;
            List<String> cols = new ArrayList<>();
            boolean ok = true;
            for (SQLSelectOrderByItem it : orderBy.getItems()) {
                SQLExpr x = StaticRuleEngine.unwrap(it.getExpr());
                StaticRuleEngine.TableRef t = StaticRuleEngine.isColumn(x) ? resolve(x, aliases, sources, md) : null;
                if (t == null || only != null && !only.equals(t)) {
                    ok = false;
                    break;
                }
                only = t;
                cols.add(col(x));
            }
            if (ok && only != null) {
                byTable.computeIfAbsent(only, k -> new Cols()).sort.addAll(cols);
            }
        }
    }

    /** 只拆 AND：OR 分支一般用不上单个复合索引 */
    static List<SQLExpr> andTerms(SQLExpr e) {
        List<SQLExpr> out = new ArrayList<>();
        if (e instanceof SQLBinaryOpExpr b && b.getOperator() == SQLBinaryOperator.BooleanAnd) {
            out.addAll(andTerms(b.getLeft()));
            out.addAll(andTerms(b.getRight()));
        } else if (e != null) {
            out.add(e);
        }
        return out;
    }

    private static void term(SQLExpr term, Map<String, StaticRuleEngine.TableRef> aliases, List<String> sources,
                             Map<StaticRuleEngine.TableRef, Cols> byTable, TableMetadata md) {
        if (term instanceof SQLInListExpr in && !in.isNot()) {
            SQLExpr x = StaticRuleEngine.unwrap(in.getExpr());
            add(x, aliases, sources, byTable, md, "eq");
            return;
        }
        if (term instanceof SQLBetweenExpr bt && !bt.isNot()) {
            add(StaticRuleEngine.unwrap(bt.getTestExpr()), aliases, sources, byTable, md, "range");
            return;
        }
        if (!(term instanceof SQLBinaryOpExpr b)) {
            return;
        }
        SQLExpr l = StaticRuleEngine.unwrap(b.getLeft());
        SQLExpr r = StaticRuleEngine.unwrap(b.getRight());
        boolean lc = StaticRuleEngine.isColumn(l);
        boolean rc = StaticRuleEngine.isColumn(r);
        switch (b.getOperator()) {
            case Equality -> {
                if (lc && rc) {
                    StaticRuleEngine.TableRef lt = resolve(l, aliases, sources, md);
                    StaticRuleEngine.TableRef rt = resolve(r, aliases, sources, md);
                    if (lt != null && rt != null && !lt.equals(rt)) {
                        byTable.computeIfAbsent(lt, k -> new Cols()).join.add(col(l));
                        byTable.computeIfAbsent(rt, k -> new Cols()).join.add(col(r));
                    }
                } else if (lc) {
                    add(l, aliases, sources, byTable, md, "eq");
                } else if (rc) {
                    add(r, aliases, sources, byTable, md, "eq");
                }
            }
            case GreaterThan, GreaterThanOrEqual, LessThan, LessThanOrEqual -> {
                if (lc && !rc) {
                    add(l, aliases, sources, byTable, md, "range");
                } else if (rc && !lc) {
                    add(r, aliases, sources, byTable, md, "range");
                }
            }
            case Like -> {
                if (lc && !StaticRuleEngine.leadingWildcard(r)) {
                    add(l, aliases, sources, byTable, md, "range");
                }
            }
            default -> {
            }
        }
    }

    private static void add(SQLExpr x, Map<String, StaticRuleEngine.TableRef> aliases, List<String> sources,
                            Map<StaticRuleEngine.TableRef, Cols> byTable, TableMetadata md, String kind) {
        if (!StaticRuleEngine.isColumn(x)) {
            return;
        }
        StaticRuleEngine.TableRef t = resolve(x, aliases, sources, md);
        String c = col(x);
        if (t == null || c == null) {
            return;
        }
        Cols cols = byTable.computeIfAbsent(t, k -> new Cols());
        switch (kind) {
            case "eq" -> cols.eq.add(c);
            case "range" -> cols.range.add(c);
            default -> {
            }
        }
    }

    private static String col(SQLExpr x) {
        String c = StaticRuleEngine.columnName(x);
        return c == null ? null : c.toUpperCase(Locale.ROOT);
    }

    /** 列属于哪张表：有别名按别名；无别名且单表即该表；多表时用元数据判断哪张表有这个列 */
    static StaticRuleEngine.TableRef resolve(SQLExpr x, Map<String, StaticRuleEngine.TableRef> aliases, List<String> sources, TableMetadata md) {
        String owner = StaticRuleEngine.ownerOf(x);
        if (owner != null) {
            return aliases.get(owner);
        }
        if (sources.size() == 1) {
            return aliases.get(sources.get(0));
        }
        String c = col(x);
        StaticRuleEngine.TableRef found = null;
        for (String s : sources) {
            StaticRuleEngine.TableRef t = aliases.get(s);
            List<String> cols = md.columns(t.schema(), t.table());
            if (cols != null && cols.contains(c)) {
                if (found != null) {
                    return null;    // 多表都有同名列：无法判断
                }
                found = t;
            }
        }
        return found;
    }
}
