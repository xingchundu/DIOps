package com.dbops.sqlinsight.optimize;

import com.alibaba.druid.DbType;
import com.alibaba.druid.sql.SQLUtils;
import com.alibaba.druid.sql.ast.SQLExpr;
import com.alibaba.druid.sql.ast.SQLLimit;
import com.alibaba.druid.sql.ast.SQLOrderBy;
import com.alibaba.druid.sql.ast.SQLStatement;
import com.alibaba.druid.sql.ast.expr.SQLAggregateExpr;
import com.alibaba.druid.sql.ast.expr.SQLAllColumnExpr;
import com.alibaba.druid.sql.ast.expr.SQLBinaryOpExpr;
import com.alibaba.druid.sql.ast.expr.SQLBinaryOperator;
import com.alibaba.druid.sql.ast.expr.SQLCharExpr;
import com.alibaba.druid.sql.ast.expr.SQLExistsExpr;
import com.alibaba.druid.sql.ast.expr.SQLIdentifierExpr;
import com.alibaba.druid.sql.ast.expr.SQLInListExpr;
import com.alibaba.druid.sql.ast.expr.SQLInSubQueryExpr;
import com.alibaba.druid.sql.ast.expr.SQLIntegerExpr;
import com.alibaba.druid.sql.ast.expr.SQLIntervalExpr;
import com.alibaba.druid.sql.ast.expr.SQLIntervalUnit;
import com.alibaba.druid.sql.ast.expr.SQLMethodInvokeExpr;
import com.alibaba.druid.sql.ast.expr.SQLNumericLiteralExpr;
import com.alibaba.druid.sql.ast.expr.SQLPropertyExpr;
import com.alibaba.druid.sql.ast.expr.SQLQueryExpr;
import com.alibaba.druid.sql.ast.statement.SQLExprTableSource;
import com.alibaba.druid.sql.ast.statement.SQLJoinTableSource;
import com.alibaba.druid.sql.ast.statement.SQLSelect;
import com.alibaba.druid.sql.ast.statement.SQLSelectItem;
import com.alibaba.druid.sql.ast.statement.SQLSelectOrderByItem;
import com.alibaba.druid.sql.ast.statement.SQLSelectQuery;
import com.alibaba.druid.sql.ast.statement.SQLSelectQueryBlock;
import com.alibaba.druid.sql.ast.statement.SQLSelectStatement;
import com.alibaba.druid.sql.ast.statement.SQLUnionOperator;
import com.alibaba.druid.sql.ast.statement.SQLUnionQuery;
import com.dbops.sqlinsight.ast.StaticRuleEngine;
import com.dbops.sqlinsight.ast.TableMetadata;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * 规则改写（不依赖大模型）：
 * <ul>
 *   <li>能安全等价改写的直接改写 AST 并输出“规则改写后 SQL”：SELECT * 展开列名、NOT IN 子查询 → NOT EXISTS、
 *       TRUNC(日期列)=值 / DATE(日期列)=值 → 范围条件、TO_CHAR(日期列,'yyyy-mm-dd')='…' → 范围条件、字符列与数字比较 → 字符字面量</li>
 *   <li>需要业务判断的只给建议和示例：OR → UNION ALL、深分页 → 游标分页、函数列 → 函数索引、前导 % → 全文检索、
 *       UNION → UNION ALL、大 IN 列表、随机排序、无条件 COUNT(*)、select 列表中的相关子查询、DISTINCT + 连接</li>
 * </ul>
 * 每次在全新解析的 AST 上改写，不影响审核用的 AST。
 */
public final class RewriteEngine {

    public record Rewrite(String code, String title, String reason, String suggestion, String example, boolean applied) {
    }

    public record Result(List<Rewrite> rewrites, String rewrittenSql) {
    }

    private static final Set<String> RANDOM_FUNCS = Set.of("RAND", "RANDOM", "NEWID", "DBMS_RANDOM.VALUE", "VALUE");

    private RewriteEngine() {
    }

    public static Result rewrite(String sql, DbType dialect, String platformType, TableMetadata meta) {
        List<Rewrite> out = new ArrayList<>();
        if (sql == null || sql.isBlank() || dialect == null) {
            return new Result(out, null);
        }
        List<SQLStatement> stmts;
        try {
            stmts = SQLUtils.parseStatements(sql.trim().replaceAll(";\\s*$", ""), dialect);
        } catch (Exception e) {
            return new Result(out, null);
        }
        if (stmts.size() != 1) {
            return new Result(out, null);
        }
        SQLStatement st = stmts.get(0);
        Ctx ctx = new Ctx(dialect, String.valueOf(platformType).toUpperCase(Locale.ROOT), meta == null ? TableMetadata.NONE : meta, out);
        if (st instanceof SQLSelectStatement s) {
            ctx.select(s.getSelect(), false, true);
        }
        String rewritten = null;
        if (out.stream().anyMatch(Rewrite::applied)) {
            try {
                rewritten = SQLUtils.toSQLString(st, dialect);
                SQLUtils.parseStatements(rewritten, dialect);      // 改写结果必须能再次解析
            } catch (Exception e) {
                rewritten = null;
                List<Rewrite> keep = new ArrayList<>();
                for (Rewrite r : out) {
                    keep.add(r.applied() ? new Rewrite(r.code(), r.title(), r.reason(), r.suggestion() + "（自动改写结果校验失败，未采用）", r.example(), false) : r);
                }
                out.clear();
                out.addAll(keep);
            }
        }
        // 同一规则只保留一条
        Map<String, Rewrite> uniq = new LinkedHashMap<>();
        for (Rewrite r : out) {
            uniq.merge(r.code(), r, (a, b) -> a.applied() ? a : b);
        }
        return new Result(new ArrayList<>(uniq.values()), rewritten);
    }

    private static final class Ctx {
        final DbType dialect;
        final String platform;
        final TableMetadata meta;
        final List<Rewrite> out;

        Ctx(DbType dialect, String platform, TableMetadata meta, List<Rewrite> out) {
            this.dialect = dialect;
            this.platform = platform;
            this.meta = meta;
            this.out = out;
        }

        boolean oracleLike() {
            return platform.contains("ORACLE") || platform.contains("DAMENG") || platform.equals("DM");
        }

        boolean mysqlLike() {
            return platform.contains("MYSQL") || platform.contains("GOLDENDB");
        }

        void select(SQLSelect s, boolean inExists, boolean top) {
            if (s == null) {
                return;
            }
            SQLSelectQuery q = s.getQuery();
            if (q instanceof SQLUnionQuery u) {
                if (u.getOperator() == SQLUnionOperator.UNION || u.getOperator() == SQLUnionOperator.DISTINCT) {
                    out.add(new Rewrite("RW-10", "UNION → UNION ALL", "UNION 会对结果去重（排序或哈希），代价随结果集增大",
                            "如果各分支结果不会重复或允许重复，改为 UNION ALL", "SELECT ... UNION ALL SELECT ...", false));
                }
                for (SQLSelectQuery r : u.getRelations()) {
                    if (r instanceof SQLSelectQueryBlock b) {
                        block(b, null, inExists, false);
                    }
                }
                return;
            }
            if (q instanceof SQLSelectQueryBlock b) {
                block(b, s.getOrderBy(), inExists, top);
                SQLLimit limit = s.getLimit() != null ? s.getLimit() : b.getLimit();
                deepPaging(limit, b.getOrderBy() != null ? b.getOrderBy() : s.getOrderBy());
            }
        }

        void block(SQLSelectQueryBlock b, SQLOrderBy outerOrder, boolean inExists, boolean top) {
            Map<String, StaticRuleEngine.TableRef> aliases = new HashMap<>();
            List<String> sources = new ArrayList<>();
            StaticRuleEngine.collectSources(b.getFrom(), aliases, sources);

            if (!inExists) {
                expandStar(b, aliases, sources);
            }
            if (b.getDistionOption() == com.alibaba.druid.sql.ast.SQLSetQuantifier.DISTINCT && b.getFrom() instanceof SQLJoinTableSource) {
                out.add(new Rewrite("RW-14", "DISTINCT + 连接 → EXISTS", "为消除连接产生的重复行而用 DISTINCT，需要先连接再去重",
                        "只需要主表数据时，把从表改为 EXISTS 子查询，避免去重", "SELECT a.* FROM a WHERE EXISTS (SELECT 1 FROM b WHERE b.aid = a.id AND ...)", false));
            }
            // select 列表中的标量子查询
            for (SQLSelectItem it : b.getSelectList()) {
                if (it.getExpr() instanceof SQLQueryExpr) {
                    out.add(new Rewrite("RW-13", "select 列表中的子查询 → 连接", "select 列表中的（相关）子查询对结果集的每一行执行一次",
                            "改为 LEFT JOIN 一个按关联列 GROUP BY 的派生表", "SELECT a.id, t.cnt FROM a LEFT JOIN (SELECT aid, COUNT(*) cnt FROM b GROUP BY aid) t ON t.aid = a.id", false));
                }
                if (top && it.getExpr() instanceof SQLAggregateExpr ag && "COUNT".equalsIgnoreCase(ag.getMethodName())
                        && b.getWhere() == null && sources.size() == 1 && b.getGroupBy() == null) {
                    StaticRuleEngine.TableRef t = aliases.get(sources.get(0));
                    Long rows = t == null ? null : meta.rowCount(t.schema(), t.table());
                    if (rows == null || rows > 1_000_000) {
                        out.add(new Rewrite("RW-12", "大表无条件 COUNT(*)", "全表计数需要扫描全表或整个索引" + (rows == null ? "" : "（统计行数约 " + rows + "）"),
                                "允许近似值时读统计信息；需要精确值且频繁调用时维护计数表 / 缓存", oracleLike()
                                ? "SELECT NUM_ROWS FROM ALL_TABLES WHERE OWNER = :o AND TABLE_NAME = :t" : "SELECT reltuples FROM pg_class WHERE relname = 't'", false));
                    }
                }
            }
            // 排序
            SQLOrderBy ob = b.getOrderBy() != null ? b.getOrderBy() : outerOrder;
            if (ob != null) {
                for (SQLSelectOrderByItem it : ob.getItems()) {
                    boolean rnd = it.getExpr() instanceof SQLMethodInvokeExpr m && isRandom(m)
                            || it.getExpr() instanceof SQLPropertyExpr pe && "DBMS_RANDOM.VALUE".equalsIgnoreCase(pe.toString().replace(" ", ""));
                    if (rnd) {
                        out.add(new Rewrite("RW-11", "随机排序", "ORDER BY 随机函数需要对全部候选行排序",
                                "先按主键范围随机取起点再取 N 行，或在应用侧随机", mysqlLike()
                                ? "SELECT ... FROM t WHERE id >= (SELECT FLOOR(RAND() * MAX(id)) FROM t) ORDER BY id LIMIT 10" : "按主键随机起点 + 取前 N 行", false));
                    }
                }
            }
            // WHERE
            if (b.getWhere() != null) {
                List<SQLExpr> terms = IndexAdvisor.andTerms(b.getWhere());
                for (SQLExpr t : terms) {
                    term(t, b, aliases, sources);
                }
                orAcrossColumns(b.getWhere(), aliases, sources);
            }
            // 子查询递归
            subqueries(b.getWhere());
            for (SQLSelectItem it : b.getSelectList()) {
                if (it.getExpr() instanceof SQLQueryExpr q) {
                    select(q.getSubQuery(), false, false);
                }
            }
            from(b.getFrom());
        }

        void from(com.alibaba.druid.sql.ast.statement.SQLTableSource ts) {
            if (ts instanceof com.alibaba.druid.sql.ast.statement.SQLSubqueryTableSource s) {
                select(s.getSelect(), false, false);
            } else if (ts instanceof SQLJoinTableSource j) {
                from(j.getLeft());
                from(j.getRight());
            }
        }

        void subqueries(SQLExpr e) {
            if (e instanceof SQLBinaryOpExpr b) {
                subqueries(b.getLeft());
                subqueries(b.getRight());
            } else if (e instanceof SQLExistsExpr ex) {
                select(ex.getSubQuery(), true, false);
            } else if (e instanceof SQLInSubQueryExpr in) {
                select(in.getSubQuery(), false, false);
            } else if (e instanceof SQLQueryExpr q) {
                select(q.getSubQuery(), false, false);
            }
        }

        // ------------------------------------------------------------ RW-01 SELECT *

        void expandStar(SQLSelectQueryBlock b, Map<String, StaticRuleEngine.TableRef> aliases, List<String> sources) {
            List<SQLSelectItem> items = b.getSelectList();
            for (int i = 0; i < items.size(); i++) {
                SQLExpr e = items.get(i).getExpr();
                String owner = null;
                boolean star = e instanceof SQLAllColumnExpr;
                if (e instanceof SQLPropertyExpr p && "*".equals(p.getName())) {
                    star = true;
                    owner = p.getOwnernName();
                }
                if (!star) {
                    continue;
                }
                StaticRuleEngine.TableRef t = owner != null ? aliases.get(StaticRuleEngine.norm(owner))
                        : sources.size() == 1 ? aliases.get(sources.get(0)) : null;
                List<String> cols = t == null ? null : meta.columns(t.schema(), t.table());
                if (cols == null || cols.isEmpty()) {
                    out.add(new Rewrite("RW-01", "SELECT * → 明确列名", "SELECT * 返回不需要的列，增加 IO/网络，表结构变更时易出错",
                            "只查询需要的列" + (t == null ? "" : "（连接目标实例后可自动展开 " + t.table() + " 的列名）"), null, false));
                    continue;
                }
                List<SQLSelectItem> repl = new ArrayList<>();
                for (String c : cols) {
                    SQLExpr ce = owner != null ? new SQLPropertyExpr(owner, c) : new SQLIdentifierExpr(c);
                    SQLSelectItem si = new SQLSelectItem(ce);
                    si.setParent(b);
                    repl.add(si);
                }
                items.remove(i);
                items.addAll(i, repl);
                i += repl.size() - 1;
                out.add(new Rewrite("RW-01", "SELECT * → 明确列名", "SELECT * 返回不需要的列，增加 IO/网络，表结构变更时易出错",
                        "已按表结构展开 " + cols.size() + " 列，请删掉业务不需要的列", null, true));
            }
        }

        // ------------------------------------------------------------ WHERE 单项

        void term(SQLExpr t, SQLSelectQueryBlock b, Map<String, StaticRuleEngine.TableRef> aliases, List<String> sources) {
            if (t instanceof SQLInSubQueryExpr in && in.isNot()) {
                notInToNotExists(in, b, aliases, sources);
                return;
            }
            if (t instanceof SQLInListExpr in && in.getTargetList() != null && in.getTargetList().size() >= 500) {
                out.add(new Rewrite("RW-09", "大 IN 列表", "IN 列表有 " + in.getTargetList().size() + " 个值，解析和执行都慢（Oracle 上限 1000）",
                        "把值写入临时表后 JOIN，或分批查询", "INSERT INTO tmp_ids ...; SELECT t.* FROM t JOIN tmp_ids x ON x.id = t.id", false));
                return;
            }
            if (!(t instanceof SQLBinaryOpExpr b2)) {
                return;
            }
            SQLBinaryOperator op = b2.getOperator();
            SQLExpr l = StaticRuleEngine.unwrap(b2.getLeft());
            SQLExpr r = StaticRuleEngine.unwrap(b2.getRight());
            if (op == SQLBinaryOperator.Like && StaticRuleEngine.leadingWildcard(r)) {
                out.add(new Rewrite("RW-07", "前导 % 模糊查询", "LIKE '%xx' 无法使用 B-Tree 索引",
                        oracleLike() ? "考虑 Oracle Text（CONTAINS）或反向键 + REVERSE 函数索引；或改为后缀匹配" : "考虑全文索引 / ngram，或把检索交给搜索引擎",
                        mysqlLike() ? "ALTER TABLE t ADD FULLTEXT INDEX ft_name (name) WITH PARSER ngram" : null, false));
                return;
            }
            if (op == SQLBinaryOperator.Equality && l instanceof SQLMethodInvokeExpr m && !StaticRuleEngine.isColumn(r)) {
                functionOnColumn(b2, m, r, aliases, sources);
                return;
            }
            if (op == SQLBinaryOperator.Equality || op == SQLBinaryOperator.NotEqual || op == SQLBinaryOperator.GreaterThan
                    || op == SQLBinaryOperator.LessThan || op == SQLBinaryOperator.GreaterThanOrEqual || op == SQLBinaryOperator.LessThanOrEqual) {
                implicitConversion(b2, l, r, aliases, sources);
            }
        }

        /** RW-02：col NOT IN (SELECT c FROM t2 WHERE ...) → NOT EXISTS (SELECT 1 FROM t2 WHERE ... AND t2.c = outer.col) */
        void notInToNotExists(SQLInSubQueryExpr in, SQLSelectQueryBlock outer, Map<String, StaticRuleEngine.TableRef> aliases, List<String> sources) {
            String reason = "NOT IN 子查询：子查询结果含 NULL 时整个条件为空集，且优化器难以改写为反连接";
            SQLExpr oc = StaticRuleEngine.unwrap(in.getExpr());
            SQLSelect sub = in.getSubQuery();
            SQLSelectQueryBlock ib = sub == null ? null : sub.getQueryBlock();
            boolean simple = StaticRuleEngine.isColumn(oc) && ib != null && ib.getSelectList().size() == 1
                    && StaticRuleEngine.isColumn(ib.getSelectList().get(0).getExpr()) && ib.getFrom() instanceof SQLExprTableSource
                    && ib.getGroupBy() == null && sub.getQuery() == ib && (sources.size() == 1 || StaticRuleEngine.ownerOf(oc) != null)
                    // 子查询带 LIMIT/FETCH/ROWNUM 时加关联条件会改变语义（原来是“前 N 行”，改写后变成“每个外层值各自的前 N 行”）
                    && ib.getLimit() == null && (ib.getWhere() == null || !String.valueOf(ib.getWhere()).toUpperCase(Locale.ROOT).contains("ROWNUM"));
            if (!simple) {
                out.add(new Rewrite("RW-02", "NOT IN → NOT EXISTS", reason, "改写为 NOT EXISTS（确认业务语义：子查询列可能为 NULL 时两者结果不同）",
                        "WHERE NOT EXISTS (SELECT 1 FROM t2 WHERE t2.c = t1.c)", false));
                return;
            }
            SQLExprTableSource its = (SQLExprTableSource) ib.getFrom();
            // 只有两侧列都确认 NOT NULL 时才等价：子查询含 NULL 时 NOT IN 为空集；外层列为 NULL 时 NOT IN 排除该行而 NOT EXISTS 保留
            StaticRuleEngine.TableRef innerRef = tableOf(its);
            StaticRuleEngine.TableRef outerRef = IndexAdvisor.resolve(oc, aliases, sources, meta);
            String ic0 = StaticRuleEngine.columnName(ib.getSelectList().get(0).getExpr());
            boolean innerNn = innerRef != null && Boolean.TRUE.equals(meta.notNull(innerRef.schema(), innerRef.table(), ic0));
            boolean outerNn = outerRef != null && Boolean.TRUE.equals(meta.notNull(outerRef.schema(), outerRef.table(), StaticRuleEngine.columnName(oc)));
            if (!innerNn || !outerNn) {
                out.add(new Rewrite("RW-02", "NOT IN → NOT EXISTS", reason,
                        "两侧列未确认 NOT NULL，未自动改写。确认 " + (innerNn ? "" : ic0 + " ") + (outerNn ? "" : StaticRuleEngine.columnName(oc) + " ")
                                + "不会为 NULL（或语义上希望 NULL 不参与排除）后改写为 NOT EXISTS",
                        "WHERE NOT EXISTS (SELECT 1 FROM t2 WHERE t2.c = t1.c)", false));
                return;
            }
            String innerAlias = its.getAlias();
            if (innerAlias == null) {
                innerAlias = "S_";
                its.setAlias(innerAlias);
                // 子查询内原来不带别名的列引用仍然有效（单表）
            }
            String outerQual = StaticRuleEngine.ownerOf(oc) != null ? null : outerQualifier(outer, aliases, sources);
            SQLExpr outerCol = outerQual == null ? oc.clone() : new SQLPropertyExpr(outerQual, StaticRuleEngine.columnName(oc));
            String innerCol = StaticRuleEngine.columnName(ib.getSelectList().get(0).getExpr());
            SQLExpr corr = new SQLBinaryOpExpr(new SQLPropertyExpr(innerAlias, innerCol), SQLBinaryOperator.Equality, outerCol, dialect);
            ib.getSelectList().clear();
            SQLSelectItem one = new SQLSelectItem(new SQLIntegerExpr(1));
            one.setParent(ib);
            ib.getSelectList().add(one);
            ib.addWhere(corr);
            SQLExistsExpr ex = new SQLExistsExpr(sub, true);
            if (SQLUtils.replaceInParent(in, ex)) {
                out.add(new Rewrite("RW-02", "NOT IN → NOT EXISTS", reason,
                        "已改写为 NOT EXISTS 关联子查询（两侧列均为 NOT NULL，结果等价）", null, true));
            } else {
                out.add(new Rewrite("RW-02", "NOT IN → NOT EXISTS", reason, "改写为 NOT EXISTS", null, false));
            }
        }

        String outerQualifier(SQLSelectQueryBlock outer, Map<String, StaticRuleEngine.TableRef> aliases, List<String> sources) {
            if (outer.getFrom() instanceof SQLExprTableSource t) {
                if (t.getAlias() != null) {
                    return t.getAlias();
                }
                return t.getTableName();
            }
            return null;
        }

        /** RW-05：TRUNC(col)=x / DATE(col)=x / TO_CHAR(col,'yyyy-mm-dd')='…' → 范围；UPPER/LOWER → 函数索引建议 */
        void functionOnColumn(SQLBinaryOpExpr eq, SQLMethodInvokeExpr m, SQLExpr value, Map<String, StaticRuleEngine.TableRef> aliases, List<String> sources) {
            String fn = m.getMethodName() == null ? "" : m.getMethodName().toUpperCase(Locale.ROOT);
            List<SQLExpr> args = m.getArguments();
            SQLExpr col = args == null || args.isEmpty() ? null : StaticRuleEngine.unwrap(args.get(0));
            if (col == null || !StaticRuleEngine.isColumn(col)) {
                return;
            }
            String reason = "条件列被函数 " + fn + "() 包裹，无法使用该列上的普通索引";
            SQLExpr lower = null;
            SQLExpr upper = null;
            // 只有比较值是“不带时间部分的日期常量”时，TRUNC(col)=x ⇔ col∈[x, x+1) 才成立；
            // 绑定变量、列、SYSDATE 等可能带时间，自动改写会改变结果，只给建议
            boolean dateConst = isDateOnlyConstant(value);
            if (!dateConst) {
                // 不自动改写，走下面的建议分支
            } else if (oracleLike() && "TRUNC".equals(fn) && args.size() == 1) {
                lower = value.clone();
                upper = new SQLBinaryOpExpr(value.clone(), SQLBinaryOperator.Add, new SQLIntegerExpr(1), dialect);
            } else if (mysqlLike() && "DATE".equals(fn) && args.size() == 1) {
                lower = value.clone();
                SQLIntervalExpr iv = new SQLIntervalExpr(new SQLIntegerExpr(1), SQLIntervalUnit.DAY);
                upper = new SQLBinaryOpExpr(value.clone(), SQLBinaryOperator.Add, iv, dialect);
            } else if (oracleLike() && "TO_CHAR".equals(fn) && args.size() == 2 && args.get(1) instanceof SQLCharExpr f
                    && value instanceof SQLCharExpr v) {
                String fmt = f.getText() == null ? "" : f.getText().toLowerCase(Locale.ROOT);
                if (fmt.equals("yyyy-mm-dd") || fmt.equals("yyyymmdd")) {
                    SQLMethodInvokeExpr toDate = new SQLMethodInvokeExpr("TO_DATE");
                    toDate.addArgument(new SQLCharExpr(v.getText()));
                    toDate.addArgument(new SQLCharExpr(f.getText()));
                    lower = toDate;
                    upper = new SQLBinaryOpExpr(toDate.clone(), SQLBinaryOperator.Add, new SQLIntegerExpr(1), dialect);
                }
            }
            if (lower != null) {
                SQLExpr range = new SQLBinaryOpExpr(
                        new SQLBinaryOpExpr(col.clone(), SQLBinaryOperator.GreaterThanOrEqual, lower, dialect),
                        SQLBinaryOperator.BooleanAnd,
                        new SQLBinaryOpExpr(col.clone(), SQLBinaryOperator.LessThan, upper, dialect), dialect);
                if (SQLUtils.replaceInParent(eq, range)) {
                    out.add(new Rewrite("RW-05", "函数包裹列 → 范围条件", reason, "已改写为等价的左闭右开范围条件，可以使用 " + col + " 上的索引", null, true));
                    return;
                }
            }
            if ("UPPER".equals(fn) || "LOWER".equals(fn)) {
                StaticRuleEngine.TableRef t = IndexAdvisor.resolve(col, aliases, sources, meta);
                String tn = t == null ? "表" : t.table();
                out.add(new Rewrite("RW-05", "函数包裹列 → 函数索引", reason, "建立函数索引，或在写入时统一大小写后直接比较",
                        mysqlLike() ? "ALTER TABLE " + tn + " ADD INDEX idx_fn ((" + fn + "(" + StaticRuleEngine.columnName(col) + ")))  -- MySQL 8.0.13+"
                                : "CREATE INDEX IDX_" + tn + "_FN ON " + tn + " (" + fn + "(" + StaticRuleEngine.columnName(col) + "))", false));
                return;
            }
            out.add(new Rewrite("RW-05", "函数包裹列", reason, "把函数移到比较值一侧（改为范围条件），或建立函数索引", null, false));
        }

        /** 日期常量：'2024-01-01' / DATE '2024-01-01' / TO_DATE('…','不含时分秒的格式') / TRUNC(常量) */
        static boolean isDateOnlyConstant(SQLExpr v) {
            if (v instanceof SQLCharExpr c) {
                String t = c.getText() == null ? "" : c.getText().trim();
                return t.matches("\\d{4}-?\\d{2}-?\\d{2}");
            }
            if (v instanceof com.alibaba.druid.sql.ast.expr.SQLDateExpr) {
                return true;
            }
            if (v instanceof SQLMethodInvokeExpr m) {
                String n = m.getMethodName() == null ? "" : m.getMethodName().toUpperCase(Locale.ROOT);
                List<SQLExpr> a = m.getArguments();
                if ("TO_DATE".equals(n) && a != null && !a.isEmpty() && a.get(0) instanceof SQLCharExpr) {
                    String fmt = a.size() > 1 && a.get(1) instanceof SQLCharExpr f && f.getText() != null ? f.getText().toLowerCase(Locale.ROOT) : "";
                    return isDateOnlyConstant(a.get(0)) && !fmt.matches(".*(hh|mi|ss).*");
                }
            }
            return false;
        }

        /** RW-06：字符列与数字字面量比较（需要元数据确认列类型）——只给建议，不自动改写 */
        void implicitConversion(SQLBinaryOpExpr b, SQLExpr l, SQLExpr r, Map<String, StaticRuleEngine.TableRef> aliases, List<String> sources) {
            SQLExpr col = StaticRuleEngine.isColumn(l) && r instanceof SQLNumericLiteralExpr ? l
                    : StaticRuleEngine.isColumn(r) && l instanceof SQLNumericLiteralExpr ? r : null;
            if (col == null) {
                return;
            }
            StaticRuleEngine.TableRef t = IndexAdvisor.resolve(col, aliases, sources, meta);
            if (t == null) {
                return;
            }
            String fam = meta.columnTypeFamily(t.schema(), t.table(), StaticRuleEngine.columnName(col).toUpperCase(Locale.ROOT));
            if (!"CHAR".equals(fam)) {
                return;
            }
            SQLNumericLiteralExpr num = (SQLNumericLiteralExpr) (col == l ? r : l);
            // 不自动改写：按数字比较时 '01'、'1.0'、' 1' 都等于 1；改成字符 '1' 后这些行不再命中，结果集会变
            out.add(new Rewrite("RW-06", "隐式类型转换", t.table() + "." + StaticRuleEngine.columnName(col) + " 是字符类型，与数字比较会对列做转换，索引失效",
                    "确认该列存的都是规范数字字符串（无前导 0 / 空格 / 小数点）后，把比较值写成字符串 '" + num.getNumber() + "'", null, false));
        }

        boolean replaceRight(SQLBinaryOpExpr b, SQLExpr x) {
            b.setRight(x);
            return true;
        }

        boolean replaceLeft(SQLBinaryOpExpr b, SQLExpr x) {
            b.setLeft(x);
            return true;
        }

        /** RW-03：同一层 OR 连接了不同列的条件 → UNION ALL（只建议） */
        void orAcrossColumns(SQLExpr where, Map<String, StaticRuleEngine.TableRef> aliases, List<String> sources) {
            for (SQLExpr t : IndexAdvisor.andTerms(where)) {
                if (t instanceof SQLBinaryOpExpr b && b.getOperator() == SQLBinaryOperator.BooleanOr) {
                    java.util.Set<String> cols = new java.util.HashSet<>();
                    orColumns(b, cols);
                    if (cols.size() >= 2) {
                        out.add(new Rewrite("RW-03", "OR 跨列 → UNION ALL", "OR 连接 " + String.join("、", cols) + " 等不同列，单个索引无法同时使用",
                                "各列分别有索引时，拆成多个查询 UNION ALL（注意去重条件）",
                                "SELECT ... WHERE a = ? UNION ALL SELECT ... WHERE b = ? AND (a <> ? OR a IS NULL)", false));
                        return;
                    }
                }
            }
        }

        void orColumns(SQLExpr e, java.util.Set<String> cols) {
            if (e instanceof SQLBinaryOpExpr b) {
                if (b.getOperator() == SQLBinaryOperator.BooleanOr || b.getOperator() == SQLBinaryOperator.BooleanAnd) {
                    orColumns(b.getLeft(), cols);
                    orColumns(b.getRight(), cols);
                } else if (StaticRuleEngine.isColumn(StaticRuleEngine.unwrap(b.getLeft()))) {
                    cols.add(String.valueOf(StaticRuleEngine.columnName(StaticRuleEngine.unwrap(b.getLeft()))).toUpperCase(Locale.ROOT));
                }
            }
        }

        /** RW-08：深分页 → 游标分页（只建议） */
        void deepPaging(SQLLimit limit, SQLOrderBy ob) {
            if (limit == null || !(limit.getOffset() instanceof SQLIntegerExpr off) || off.getNumber().longValue() < 10000) {
                return;
            }
            String key = ob != null && !ob.getItems().isEmpty() ? String.valueOf(ob.getItems().get(0).getExpr()) : "id";
            String rowCount = limit.getRowCount() == null ? "N" : String.valueOf(limit.getRowCount());
            out.add(new Rewrite("RW-08", "深分页 → 游标分页", "偏移量 " + off.getNumber() + "：数据库要先读出并丢弃前面所有行",
                    "记住上一页最后一行的排序键，用 “排序键 > 上次值” 代替 OFFSET",
                    oracleLike() ? "SELECT * FROM (SELECT ... FROM t WHERE " + key + " > :last ORDER BY " + key + ") WHERE ROWNUM <= " + rowCount
                            : "SELECT ... FROM t WHERE " + key + " > :last ORDER BY " + key + " LIMIT " + rowCount, false));
        }

        StaticRuleEngine.TableRef tableOf(SQLExprTableSource ts) {
            SQLExpr e = ts.getExpr();
            if (e instanceof SQLPropertyExpr p) {
                return new StaticRuleEngine.TableRef(StaticRuleEngine.strip(p.getOwnerName()).toUpperCase(Locale.ROOT),
                        StaticRuleEngine.strip(p.getName()).toUpperCase(Locale.ROOT));
            }
            if (e instanceof SQLIdentifierExpr id) {
                return new StaticRuleEngine.TableRef(null, StaticRuleEngine.strip(id.getName()).toUpperCase(Locale.ROOT));
            }
            return null;
        }

        boolean isRandom(SQLMethodInvokeExpr m) {
            String n = m.getMethodName() == null ? "" : m.getMethodName().toUpperCase(Locale.ROOT);
            String owner = m.getOwner() == null ? "" : m.getOwner().toString().toUpperCase(Locale.ROOT) + ".";
            return RANDOM_FUNCS.contains(n) && (!n.equals("VALUE") || owner.equals("DBMS_RANDOM."));
        }
    }
}
