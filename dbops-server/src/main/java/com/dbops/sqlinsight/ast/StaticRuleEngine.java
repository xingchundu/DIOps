package com.dbops.sqlinsight.ast;

import com.alibaba.druid.sql.ast.SQLExpr;
import com.alibaba.druid.sql.ast.SQLLimit;
import com.alibaba.druid.sql.ast.SQLObject;
import com.alibaba.druid.sql.ast.SQLStatement;
import com.alibaba.druid.sql.ast.expr.SQLAggregateExpr;
import com.alibaba.druid.sql.ast.expr.SQLAllColumnExpr;
import com.alibaba.druid.sql.ast.expr.SQLBetweenExpr;
import com.alibaba.druid.sql.ast.expr.SQLBinaryOpExpr;
import com.alibaba.druid.sql.ast.expr.SQLBinaryOperator;
import com.alibaba.druid.sql.ast.expr.SQLCastExpr;
import com.alibaba.druid.sql.ast.expr.SQLCharExpr;
import com.alibaba.druid.sql.ast.expr.SQLExistsExpr;
import com.alibaba.druid.sql.ast.expr.SQLIdentifierExpr;
import com.alibaba.druid.sql.ast.expr.SQLInListExpr;
import com.alibaba.druid.sql.ast.expr.SQLInSubQueryExpr;
import com.alibaba.druid.sql.ast.expr.SQLIntegerExpr;
import com.alibaba.druid.sql.ast.expr.SQLMethodInvokeExpr;
import com.alibaba.druid.sql.ast.expr.SQLNumericLiteralExpr;
import com.alibaba.druid.sql.ast.expr.SQLPropertyExpr;
import com.alibaba.druid.sql.ast.statement.SQLAlterTableAddColumn;
import com.alibaba.druid.sql.ast.statement.SQLAlterTableItem;
import com.alibaba.druid.sql.ast.statement.SQLAlterTableStatement;
import com.alibaba.druid.sql.ast.statement.SQLColumnDefinition;
import com.alibaba.druid.sql.ast.statement.SQLDeleteStatement;
import com.alibaba.druid.sql.ast.statement.SQLDropTableStatement;
import com.alibaba.druid.sql.ast.statement.SQLExprTableSource;
import com.alibaba.druid.sql.ast.statement.SQLJoinTableSource;
import com.alibaba.druid.sql.ast.statement.SQLSelect;
import com.alibaba.druid.sql.ast.statement.SQLSelectItem;
import com.alibaba.druid.sql.ast.statement.SQLSelectQueryBlock;
import com.alibaba.druid.sql.ast.statement.SQLTableSource;
import com.alibaba.druid.sql.ast.statement.SQLTruncateStatement;
import com.alibaba.druid.sql.ast.statement.SQLUpdateStatement;
import com.alibaba.druid.sql.dialect.oracle.ast.expr.OracleOuterExpr;
import com.alibaba.druid.sql.ast.expr.SQLQueryExpr;
import com.alibaba.druid.sql.ast.statement.SQLInsertStatement;
import com.alibaba.druid.sql.ast.statement.SQLMergeStatement;
import com.alibaba.druid.sql.ast.statement.SQLSelectQuery;
import com.alibaba.druid.sql.ast.statement.SQLSelectStatement;
import com.alibaba.druid.sql.ast.statement.SQLSubqueryTableSource;
import com.alibaba.druid.sql.ast.statement.SQLUnionQuery;
import com.alibaba.druid.sql.ast.statement.SQLUnionQueryTableSource;
import com.alibaba.druid.sql.ast.statement.SQLWithSubqueryClause;

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
 * 静态规则（AST）：S-001~S-007（设计文档 4.2）+ 发布策略 D-001~D-003 + 优化提示 H-001~H-003。
 * <p>
 * 纯函数：输入解析结果、规则视图、元数据，输出命中与跳过列表。替代原先 4 套正则/SQLGlot 规则。
 */
public final class StaticRuleEngine {

    /** 规则视图：code → 是否启用 / 级别 / 参数 */
    public interface RuleView {
        boolean enabled(String code);

        String severity(String code, String def);

        double param(String code, String key, double def);

        RuleView DEFAULTS = new RuleView() {
            @Override
            public boolean enabled(String code) {
                return true;
            }

            @Override
            public String severity(String code, String def) {
                return def;
            }

            @Override
            public double param(String code, String key, double def) {
                return def;
            }
        };
    }

    public record Result(List<Finding> findings, List<Finding.Skipped> skipped) {
    }

    private StaticRuleEngine() {
    }

    public static Result analyze(SqlAstService.SqlAnalysis a, RuleView rules, TableMetadata meta) {
        List<Finding> out = new ArrayList<>();
        List<Finding.Skipped> skipped = new ArrayList<>();
        if (!a.parsed()) {
            skipped.add(new Finding.Skipped("S-*", "SQL 解析失败，静态规则未执行（记为“未分析”，不能视为通过）：" + a.parseError()));
            return new Result(out, skipped);
        }
        TableMetadata md = meta == null ? TableMetadata.NONE : meta;
        Ctx ctx = new Ctx(rules == null ? RuleView.DEFAULTS : rules, md, out, a.schema());
        for (SQLStatement st : a.statements()) {
            ctx.statementChecks(st);
            new Walker(ctx).statement(st);
        }
        if (ctx.needTypeMeta && !ctx.typeMetaUsed) {
            skipped.add(new Finding.Skipped("S-006", "缺少字段类型元数据（未指定实例或无权限读取字典），隐式类型转换未检查"));
        }
        // 去重：同一规则同一信息只报一次
        Map<String, Finding> uniq = new LinkedHashMap<>();
        for (Finding f : out) {
            uniq.putIfAbsent(f.code() + "|" + f.message(), f);
        }
        return new Result(new ArrayList<>(uniq.values()), skipped);
    }

    // ===================================================================

    private static final class Ctx {
        final RuleView rules;
        final TableMetadata meta;
        final List<Finding> out;
        final String defaultSchema;
        boolean needTypeMeta;
        boolean typeMetaUsed;

        Ctx(RuleView rules, TableMetadata meta, List<Finding> out, String defaultSchema) {
            this.rules = rules;
            this.meta = meta;
            this.out = out;
            this.defaultSchema = "-".equals(defaultSchema) ? null : defaultSchema;
        }

        void add(String code, String defSev, String title, String msg, String suggestion) {
            if (!rules.enabled(code)) {
                return;
            }
            out.add(new Finding(code, rules.severity(code, defSev), title, msg, suggestion));
        }

        void statementChecks(SQLStatement st) {
            if (st instanceof SQLUpdateStatement u && u.getWhere() == null) {
                add("S-001", "CRITICAL", "UPDATE 无 WHERE", "UPDATE 语句没有 WHERE 条件，将更新整表", "补充过滤条件；确需全表更新请分批执行并走变更审批");
            }
            if (st instanceof SQLDeleteStatement d && d.getWhere() == null) {
                add("S-001", "CRITICAL", "DELETE 无 WHERE", "DELETE 语句没有 WHERE 条件，将删除整表数据", "补充过滤条件；清空表请走变更审批");
            }
            if (st instanceof SQLDropTableStatement) {
                add("D-001", "CRITICAL", "DROP TABLE", "禁止直接 DROP TABLE，需通过数据安全申请", null);
            }
            if (st instanceof SQLTruncateStatement) {
                add("D-002", "CRITICAL", "TRUNCATE", "禁止 TRUNCATE TABLE，需人工审批", null);
            }
            if (st instanceof SQLAlterTableStatement alt) {
                for (SQLAlterTableItem item : alt.getItems()) {
                    if (item instanceof SQLAlterTableAddColumn add) {
                        for (SQLColumnDefinition c : add.getColumns()) {
                            if (c.getDefaultExpr() == null) {
                                add("D-003", "WARNING", "新增列无默认值",
                                        "新增列 " + c.getName() + " 未设置 DEFAULT 值", "存量行将为 NULL；NOT NULL 列必须提供默认值");
                            }
                        }
                    }
                }
            }
        }
    }

    /** 表别名 → 物理表（SqlOptimizeService 复用） */
    public record TableRef(String schema, String table) {
    }

    /**
     * 手写遍历（不依赖 Druid Visitor 分发：方言节点对通用 Visitor 的回退实现不一致，
     * 例如 OracleUpdateStatement 会无限递归）。方言类都继承通用 AST 类，instanceof 即可覆盖全部方言。
     */
    private static final class Walker {
        private final Ctx ctx;
        private int depth;

        Walker(Ctx ctx) {
            this.ctx = ctx;
        }

        void statement(SQLStatement st) {
            if (st instanceof SQLSelectStatement s) {
                select(s.getSelect(), false);
            } else if (st instanceof SQLUpdateStatement u) {
                tableSource(u.getTableSource());
                tableSource(u.getFrom());
                expr(u.getWhere());
                // SET 子句里的标量子查询 / 表达式也要检查（原来不遍历，SET x = (SELECT … WHERE f(col)=…) 漏检）
                if (u.getItems() != null) {
                    for (com.alibaba.druid.sql.ast.statement.SQLUpdateSetItem it : u.getItems()) {
                        expr(it.getValue());
                    }
                }
            } else if (st instanceof SQLDeleteStatement d) {
                tableSource(d.getTableSource());
                tableSource(d.getFrom());
                expr(d.getWhere());
            } else if (st instanceof SQLInsertStatement ins) {
                select(ins.getQuery(), false);
            } else if (st instanceof SQLMergeStatement m) {
                tableSource(m.getUsing());
                expr(m.getOn());
            }
        }

        void select(SQLSelect s, boolean inExists) {
            if (s == null || depth > 64) {
                return;
            }
            depth++;
            try {
                SQLWithSubqueryClause with = s.getWithSubQuery();
                if (with != null && with.getEntries() != null) {
                    for (SQLWithSubqueryClause.Entry e : with.getEntries()) {
                        select(e.getSubQuery(), false);
                    }
                }
                query(s.getQuery(), inExists);
            } finally {
                depth--;
            }
        }

        void query(SQLSelectQuery q, boolean inExists) {
            if (q instanceof SQLSelectQueryBlock qb) {
                block(qb, inExists);
            } else if (q instanceof SQLUnionQuery u) {
                List<SQLSelectQuery> rel = u.getRelations();
                if (rel != null && !rel.isEmpty()) {
                    for (SQLSelectQuery r : rel) {
                        query(r, inExists);
                    }
                } else {
                    query(u.getLeft(), inExists);
                    query(u.getRight(), inExists);
                }
            }
        }

        void tableSource(SQLTableSource ts) {
            if (ts instanceof SQLJoinTableSource j) {
                tableSource(j.getLeft());
                tableSource(j.getRight());
                expr(j.getCondition());
            } else if (ts instanceof SQLSubqueryTableSource sq) {
                select(sq.getSelect(), false);
            } else if (ts instanceof SQLUnionQueryTableSource uq) {
                query(uq.getUnion(), false);
            }
        }

        void expr(SQLExpr e) {
            if (e == null || depth > 256) {
                return;
            }
            depth++;
            try {
                if (e instanceof SQLBinaryOpExpr b) {
                    likeCheck(b);
                    expr(b.getLeft());
                    expr(b.getRight());
                    return;
                }
                if (e instanceof SQLInListExpr in) {
                    inListCheck(in);
                    expr(in.getExpr());
                    return;
                }
                if (e instanceof SQLInSubQueryExpr in) {
                    if (in.isNot()) {
                        ctx.add("H-001", "INFO", "NOT IN 子查询", "NOT IN 子查询：子查询结果含 NULL 时整体返回空集",
                                "改写为 NOT EXISTS，或确保子查询列 NOT NULL");
                    }
                    expr(in.getExpr());
                    select(in.getSubQuery(), false);
                    return;
                }
                if (e instanceof SQLExistsExpr ex) {
                    select(ex.getSubQuery(), true);
                    return;
                }
                if (e instanceof SQLQueryExpr q) {
                    select(q.getSubQuery(), false);
                    return;
                }
                List<SQLObject> children = e.getChildren();
                if (children != null) {
                    for (SQLObject c : children) {
                        if (c instanceof SQLExpr ce && c != e) {
                            expr(ce);
                        } else if (c instanceof SQLSelect cs) {
                            select(cs, false);
                        }
                    }
                }
            } catch (RuntimeException ignore) {
                // 个别方言节点 getChildren 未实现，跳过
            } finally {
                depth--;
            }
        }

        private void block(SQLSelectQueryBlock x, boolean inExists) {
            Map<String, TableRef> aliases = new HashMap<>();
            List<String> sources = new ArrayList<>();
            collectSources(x.getFrom(), aliases, sources);
            if (!inExists) {
                checkSelectStar(x);
            }
            checkCartesian(x, aliases);
            checkPaging(x);
            List<SQLExpr> conds = new ArrayList<>();
            if (x.getWhere() != null) {
                conds.add(x.getWhere());
            }
            collectJoinConditions(x.getFrom(), conds);
            for (SQLExpr c : conds) {
                checkPredicates(c, aliases);
            }
            // 继续深入子查询与表达式
            for (SQLSelectItem item : x.getSelectList()) {
                expr(item.getExpr());
            }
            tableSource(x.getFrom());
            expr(x.getWhere());
            if (x.getGroupBy() != null) {
                expr(x.getGroupBy().getHaving());
            }
        }

        private void likeCheck(SQLBinaryOpExpr x) {
            SQLBinaryOperator op = x.getOperator();
            if (op == SQLBinaryOperator.Like || op == SQLBinaryOperator.NotLike || op == SQLBinaryOperator.ILike
                    || op == SQLBinaryOperator.NotILike) {
                if (leadingWildcard(x.getRight())) {
                    ctx.add("S-004", "WARNING", "LIKE 前导通配符", "LIKE 条件以 % 或 _ 开头：" + shortSql(x),
                            "前导通配符无法使用 B-Tree 索引，考虑全文检索、反向索引或改写查询");
                }
            }
        }

        private void inListCheck(SQLInListExpr x) {
            int max = (int) ctx.rules.param("S-007", "maxInList", 1000);
            if (x.getTargetList() != null && x.getTargetList().size() >= max) {
                ctx.add("S-007", "WARNING", "IN 列表过长", "IN 列表包含 " + x.getTargetList().size() + " 个参数（阈值 " + max + "）",
                        "改用临时表 / JOIN 或 EXISTS；Oracle 单个 IN 列表上限 1000");
            }
        }

        // ---------------------------------------------------- S-003

        private void checkSelectStar(SQLSelectQueryBlock x) {
            SQLObject p = x.getParent();
            if (p instanceof SQLSelect && p.getParent() instanceof SQLExistsExpr) {
                return; // EXISTS (SELECT * ...) 无害
            }
            for (SQLSelectItem item : x.getSelectList()) {
                SQLExpr e = item.getExpr();
                if (e instanceof SQLAllColumnExpr || (e instanceof SQLPropertyExpr pe && "*".equals(pe.getName()))) {
                    ctx.add("S-003", "INFO", "SELECT *", "查询使用了 SELECT *", "明确列出所需字段，减少 IO/网络传输并避免表结构变更带来的影响");
                    return;
                }
            }
        }

        // ---------------------------------------------------- S-002

        private void checkCartesian(SQLSelectQueryBlock x, Map<String, TableRef> aliases) {
            SQLTableSource from = x.getFrom();
            if (!(from instanceof SQLJoinTableSource)) {
                return;
            }
            // 收集“没有显式连接条件”的连接里涉及的物理表
            Set<String> loose = new LinkedHashSet<>();
            boolean explicitMissing = collectLooseJoins(from, loose);
            if (loose.size() < 2) {
                return;
            }
            // 并查集：WHERE / ON 中的列等值条件把表连起来
            Map<String, String> parent = new HashMap<>();
            for (String s : loose) {
                parent.put(s, s);
            }
            List<SQLExpr> conds = new ArrayList<>();
            if (x.getWhere() != null) {
                conds.add(x.getWhere());
            }
            collectJoinConditions(from, conds);
            boolean ambiguous = false;
            for (SQLExpr c : conds) {
                for (SQLBinaryOpExpr eq : equalities(c)) {
                    String l = ownerOf(unwrap(eq.getLeft()));
                    String r = ownerOf(unwrap(eq.getRight()));
                    boolean lc = isColumn(unwrap(eq.getLeft()));
                    boolean rc = isColumn(unwrap(eq.getRight()));
                    if (lc && rc) {
                        if (l == null || r == null) {
                            ambiguous = true; // 未加表前缀的列等值，无法判断归属，保守不报
                        } else if (parent.containsKey(l) && parent.containsKey(r)) {
                            union(parent, l, r);
                        }
                    }
                }
            }
            if (ambiguous && !explicitMissing) {
                return;
            }
            Set<String> roots = new HashSet<>();
            for (String s : loose) {
                roots.add(find(parent, s));
            }
            if (roots.size() > 1) {
                ctx.add("S-002", "CRITICAL", "多表连接缺少连接条件",
                        "表 " + String.join(", ", loose) + " 之间缺少连接条件，可能产生笛卡尔积",
                        "为每对表补充等值连接条件；确需笛卡尔积请显式写 CROSS JOIN");
            }
        }

        /** @return 是否存在“显式 JOIN 但没有 ON/USING” */
        private boolean collectLooseJoins(SQLTableSource ts, Set<String> loose) {
            if (!(ts instanceof SQLJoinTableSource j)) {
                return false;
            }
            boolean explicitMissing = false;
            SQLJoinTableSource.JoinType t = j.getJoinType();
            boolean noCond = j.getCondition() == null && (j.getUsing() == null || j.getUsing().isEmpty());
            boolean isNatural = t != null && t.name().startsWith("NATURAL");
            boolean isCross = t == SQLJoinTableSource.JoinType.CROSS_JOIN || t == SQLJoinTableSource.JoinType.CROSS_APPLY
                    || t == SQLJoinTableSource.JoinType.OUTER_APPLY;
            if (noCond && !isNatural && !isCross) {
                if (t != SQLJoinTableSource.JoinType.COMMA) {
                    explicitMissing = true;
                }
                addPhysical(j.getLeft(), loose);
                addPhysical(j.getRight(), loose);
            }
            explicitMissing |= collectLooseJoins(j.getLeft(), loose);
            explicitMissing |= collectLooseJoins(j.getRight(), loose);
            return explicitMissing;
        }

        private void addPhysical(SQLTableSource ts, Set<String> loose) {
            if (ts instanceof SQLExprTableSource e) {
                String name = norm(e.getTableName());
                if (name == null || "dual".equals(name)) {
                    return;
                }
                String alias = e.getAlias() != null ? norm(e.getAlias()) : name;
                loose.add(alias);
            } else if (ts instanceof SQLJoinTableSource j) {
                addPhysical(j.getLeft(), loose);
                addPhysical(j.getRight(), loose);
            }
            // 派生表 / 表函数不参与判断（常见的单行子查询不应误报）
        }

        private static String find(Map<String, String> p, String x) {
            while (!p.get(x).equals(x)) {
                x = p.get(x);
            }
            return x;
        }

        private static void union(Map<String, String> p, String a, String b) {
            p.put(find(p, a), find(p, b));
        }

        // ---------------------------------------------------- H-002 / H-003

        private void checkPaging(SQLSelectQueryBlock x) {
            SQLLimit limit = x.getLimit();
            if (limit == null && x.getParent() instanceof SQLSelect sel) {
                limit = sel.getLimit();
            }
            if (limit == null) {
                return;
            }
            boolean ordered = x.getOrderBy() != null
                    || (x.getParent() instanceof SQLSelect sel2 && sel2.getOrderBy() != null);
            if (!ordered) {
                ctx.add("H-002", "INFO", "分页未排序", "LIMIT/FETCH 分页没有 ORDER BY，结果顺序不确定", "为分页查询指定稳定的排序列");
            }
            int maxOffset = (int) ctx.rules.param("H-003", "maxOffset", 10000);
            if (limit.getOffset() instanceof SQLIntegerExpr off && off.getNumber().longValue() >= maxOffset) {
                ctx.add("H-003", "INFO", "深分页", "OFFSET " + off.getNumber() + " 过大，数据库需扫描并丢弃前面所有行",
                        "改为基于上一页最后一条键值的游标分页");
            }
        }

        // ---------------------------------------------------- S-005 / S-006

        private void checkPredicates(SQLExpr cond, Map<String, TableRef> aliases) {
            for (SQLExpr[] pair : comparisons(cond)) {
                SQLExpr l = unwrap(pair[0]);
                SQLExpr r = pair[1] == null ? null : unwrap(pair[1]);
                checkFunctionOnColumn(l, r, aliases);
                if (r != null) {
                    checkFunctionOnColumn(r, l, aliases);
                    checkImplicitConversion(l, r, aliases);
                    checkImplicitConversion(r, l, aliases);
                }
            }
        }

        private void checkFunctionOnColumn(SQLExpr side, SQLExpr other, Map<String, TableRef> aliases) {
            boolean wrapped = side instanceof SQLMethodInvokeExpr || side instanceof SQLCastExpr
                    || (side instanceof SQLBinaryOpExpr b && isArithmetic(b.getOperator()));
            if (!wrapped || side instanceof SQLAggregateExpr) {
                return;
            }
            List<SQLExpr> cols = new ArrayList<>();
            collectColumns(side, cols);
            if (cols.isEmpty()) {
                return;
            }
            // 另一侧也是同表列时（如 a.x + 1 = a.y）不属于“索引列用函数”（原来注释写了但没实现，会误报）
            List<SQLExpr> otherCols = new ArrayList<>();
            collectColumns(other, otherCols);
            Set<String> otherTables = new java.util.HashSet<>();
            for (SQLExpr oc : otherCols) {
                TableRef ot = resolve(oc, aliases);
                if (ot != null) {
                    otherTables.add(upper(ot.table()));
                }
            }
            for (SQLExpr col : cols) {
                TableRef tr = resolve(col, aliases);
                String colName = upper(columnName(col));
                if (tr == null || colName == null || otherTables.contains(upper(tr.table()))) {
                    continue;
                }
                Set<String> idx = ctx.meta.indexedColumns(tr.schema() != null ? tr.schema() : ctx.defaultSchema, tr.table());
                String expr = shortSql(side);
                if (idx == null) {
                    ctx.add("S-005", "INFO", "列上使用函数或运算",
                            "条件 " + expr + " 对列 " + colName + " 使用了函数/运算（未获取索引元数据，无法确认是否为索引列）",
                            "如该列有索引，请把函数移到常量一侧或建立函数索引");
                } else if (idx.contains(colName)) {
                    ctx.add("S-005", "WARNING", "索引列使用函数或运算",
                            "索引列 " + tr.table() + "." + colName + " 在条件 " + expr + " 中被函数/运算包裹，索引失效",
                            "将函数应用到常量一侧，或建立函数索引（Oracle/PG 支持表达式索引）");
                }
            }
        }

        private void checkImplicitConversion(SQLExpr colSide, SQLExpr litSide, Map<String, TableRef> aliases) {
            if (!isColumn(colSide) || !(litSide instanceof SQLNumericLiteralExpr)) {
                return;
            }
            ctx.needTypeMeta = true;
            TableRef tr = resolve(colSide, aliases);
            String colName = upper(columnName(colSide));
            if (tr == null || colName == null) {
                return;
            }
            String fam = ctx.meta.columnTypeFamily(tr.schema() != null ? tr.schema() : ctx.defaultSchema, tr.table(), colName);
            if (fam == null) {
                return;
            }
            ctx.typeMetaUsed = true;
            if ("CHAR".equals(fam)) {
                ctx.add("S-006", "WARNING", "疑似隐式类型转换",
                        "字符列 " + tr.table() + "." + colName + " 与数字常量比较（" + shortSql(litSide.getParent()) + "），数据库会对列做类型转换导致索引失效",
                        "常量改为字符串字面量，或修正字段类型");
            }
        }

        private TableRef resolve(SQLExpr col, Map<String, TableRef> aliases) {
            String owner = ownerOf(col);
            if (owner != null) {
                return aliases.get(owner);
            }
            if (aliases.size() == 1) {
                return aliases.values().iterator().next();
            }
            return null;
        }
    }

    // =================================================================== 工具

    public static void collectSources(SQLTableSource ts, Map<String, TableRef> aliases, List<String> sources) {
        if (ts instanceof SQLExprTableSource e) {
            String table = e.getTableName();
            if (table == null) {
                return;
            }
            String schema = e.getSchema();
            TableRef ref = new TableRef(schema == null ? null : strip(schema).toUpperCase(Locale.ROOT), strip(table).toUpperCase(Locale.ROOT));
            String key = e.getAlias() != null ? norm(e.getAlias()) : norm(table);
            aliases.put(key, ref);
            aliases.putIfAbsent(norm(table), ref);
            sources.add(key);
        } else if (ts instanceof SQLJoinTableSource j) {
            collectSources(j.getLeft(), aliases, sources);
            collectSources(j.getRight(), aliases, sources);
        }
    }

    public static void collectJoinConditions(SQLTableSource ts, List<SQLExpr> out) {
        if (ts instanceof SQLJoinTableSource j) {
            if (j.getCondition() != null) {
                out.add(j.getCondition());
            }
            collectJoinConditions(j.getLeft(), out);
            collectJoinConditions(j.getRight(), out);
        }
    }

    /** 拆 AND/OR，取出比较谓词（左右两侧；IN/BETWEEN 只取被测表达式） */
    public static List<SQLExpr[]> comparisons(SQLExpr e) {
        List<SQLExpr[]> out = new ArrayList<>();
        walkComparisons(e, out);
        return out;
    }

    private static void walkComparisons(SQLExpr e, List<SQLExpr[]> out) {
        if (e instanceof SQLBinaryOpExpr b) {
            SQLBinaryOperator op = b.getOperator();
            if (op == SQLBinaryOperator.BooleanAnd || op == SQLBinaryOperator.BooleanOr) {
                walkComparisons(b.getLeft(), out);
                walkComparisons(b.getRight(), out);
            } else if (isComparison(op)) {
                out.add(new SQLExpr[]{b.getLeft(), b.getRight()});
            }
        } else if (e instanceof SQLInListExpr in) {
            out.add(new SQLExpr[]{in.getExpr(), null});
        } else if (e instanceof SQLBetweenExpr bt) {
            out.add(new SQLExpr[]{bt.getTestExpr(), null});
        }
    }

    private static List<SQLBinaryOpExpr> equalities(SQLExpr e) {
        List<SQLBinaryOpExpr> out = new ArrayList<>();
        if (e instanceof SQLBinaryOpExpr b) {
            if (b.getOperator() == SQLBinaryOperator.BooleanAnd || b.getOperator() == SQLBinaryOperator.BooleanOr) {
                out.addAll(equalities(b.getLeft()));
                out.addAll(equalities(b.getRight()));
            } else if (b.getOperator() == SQLBinaryOperator.Equality) {
                out.add(b);
            }
        }
        return out;
    }

    private static boolean isComparison(SQLBinaryOperator op) {
        return switch (op) {
            case Equality, NotEqual, LessThanOrGreater, GreaterThan, GreaterThanOrEqual, LessThan, LessThanOrEqual,
                 Like, NotLike, ILike, NotILike -> true;
            default -> false;
        };
    }

    private static boolean isArithmetic(SQLBinaryOperator op) {
        return switch (op) {
            case Add, Subtract, Multiply, Divide, Modulus, Concat -> true;
            default -> false;
        };
    }

    public static boolean leadingWildcard(SQLExpr e) {
        SQLExpr x = unwrap(e);
        if (x instanceof SQLCharExpr c) {
            String t = c.getText();
            return t != null && (t.startsWith("%") || t.startsWith("_"));
        }
        if (x instanceof SQLBinaryOpExpr b && b.getOperator() == SQLBinaryOperator.Concat) {
            return leadingWildcard(b.getLeft());
        }
        if (x instanceof SQLMethodInvokeExpr m && "concat".equalsIgnoreCase(m.getMethodName())
                && m.getArguments() != null && !m.getArguments().isEmpty()) {
            return leadingWildcard(m.getArguments().get(0));
        }
        return false;
    }

    public static SQLExpr unwrap(SQLExpr e) {
        SQLExpr x = e;
        while (x instanceof OracleOuterExpr o) {
            x = o.getExpr();
        }
        return x;
    }

    public static boolean isColumn(SQLExpr e) {
        return e instanceof SQLIdentifierExpr || (e instanceof SQLPropertyExpr p && !"*".equals(p.getName()));
    }

    private static void collectColumns(SQLExpr e, List<SQLExpr> out) {
        if (e == null) {
            return;
        }
        if (isColumn(e)) {
            out.add(e);
        } else if (e instanceof SQLMethodInvokeExpr m) {
            if (m.getArguments() != null) {
                for (SQLExpr a : m.getArguments()) {
                    collectColumns(a, out);
                }
            }
        } else if (e instanceof SQLCastExpr c) {
            collectColumns(c.getExpr(), out);
        } else if (e instanceof SQLBinaryOpExpr b) {
            collectColumns(b.getLeft(), out);
            collectColumns(b.getRight(), out);
        }
    }

    public static String ownerOf(SQLExpr e) {
        if (e instanceof SQLPropertyExpr p) {
            return norm(p.getOwnernName());
        }
        return null;
    }

    public static String columnName(SQLExpr e) {
        if (e instanceof SQLPropertyExpr p) {
            return strip(p.getName());
        }
        if (e instanceof SQLIdentifierExpr i) {
            String n = strip(i.getName());
            // Oracle 伪列 / 关键字不当作列
            String u = n.toUpperCase(Locale.ROOT);
            if (u.equals("ROWNUM") || u.equals("SYSDATE") || u.equals("SYSTIMESTAMP") || u.equals("LEVEL") || u.equals("ROWID")) {
                return null;
            }
            return n;
        }
        return null;
    }

    public static String norm(String s) {
        if (s == null) {
            return null;
        }
        String x = strip(s);
        int dot = x.lastIndexOf('.');
        return (dot >= 0 ? x.substring(dot + 1) : x).toLowerCase(Locale.ROOT);
    }

    public static String strip(String s) {
        return s == null ? null : s.replace("\"", "").replace("`", "").replace("[", "").replace("]", "");
    }

    private static String upper(String s) {
        return s == null ? null : s.toUpperCase(Locale.ROOT);
    }

    private static String shortSql(SQLObject o) {
        String s = String.valueOf(o).replaceAll("\\s+", " ");
        return s.length() > 120 ? s.substring(0, 120) + "…" : s;
    }
}
