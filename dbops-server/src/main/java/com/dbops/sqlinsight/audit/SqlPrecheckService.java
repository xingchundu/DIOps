package com.dbops.sqlinsight.audit;

import com.alibaba.druid.DbType;
import com.alibaba.druid.sql.SQLUtils;
import com.dbops.common.Values;
import com.dbops.sqlinsight.ast.SqlAstService;
import com.dbops.sqlinsight.ast.SqlDialect;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * 优化前静态预检（不连库）：语法、方言、语句类型，对齐 Python sql_precheck。
 */
@Service
public class SqlPrecheckService {

    private static final Pattern PLSQL = Pattern.compile(
            "(?is)^\\s*(DECLARE|BEGIN|CREATE\\s+(OR\\s+REPLACE\\s+)?(PROCEDURE|FUNCTION|PACKAGE|TRIGGER))\\b");
    private static final Pattern WHERE = Pattern.compile("(?i)\\bWHERE\\b");

    private static final List<DbType> CANDIDATES = List.of(DbType.oracle, DbType.mysql, DbType.postgresql, DbType.sqlserver);

    private final SqlAstService ast;

    public SqlPrecheckService(SqlAstService ast) {
        this.ast = ast;
    }

    public Map<String, Object> precheck(String sql, String dbType) {
        try {
            return doPrecheck(sql, dbType);
        } catch (Exception e) {
            Map<String, Object> res = new LinkedHashMap<>();
            res.put("ok", false);
            res.put("dbType", dbType);
            res.put("dialect", null);
            res.put("errors", List.of("SQL 预检异常: " + Values.truncate(e.getMessage(), 120)));
            res.put("warnings", List.<String>of());
            res.put("statements", 0);
            res.put("stmtType", "OTHER");
            res.put("likelyDialect", null);
            res.put("sql", sql == null ? "" : sql.trim());
            return res;
        }
    }

    private Map<String, Object> doPrecheck(String sql, String dbType) {
        String raw = sql == null ? "" : sql.trim();
        DbType dialect = SqlDialect.of(dbType);
        String dialectName = dialect == null ? null : dialect.name();

        Map<String, Object> res = new LinkedHashMap<>();
        res.put("ok", true);
        res.put("dbType", dbType);
        res.put("dialect", dialectName);
        res.put("errors", new ArrayList<String>());
        res.put("warnings", new ArrayList<String>());
        res.put("statements", 0);
        res.put("stmtType", "OTHER");
        res.put("likelyDialect", null);
        res.put("sql", raw);

        @SuppressWarnings("unchecked")
        List<String> errors = (List<String>) res.get("errors");
        @SuppressWarnings("unchecked")
        List<String> warnings = (List<String>) res.get("warnings");

        if (raw.isEmpty()) {
            res.put("ok", false);
            errors.add("SQL 为空");
            return res;
        }
        if (PLSQL.matcher(raw).find()) {
            res.put("ok", false);
            res.put("stmtType", "PLSQL");
            errors.add("检测到存储过程/匿名块（PL/SQL、PL/pgSQL 等），不属于单条 SQL 优化范围，请提取其中的 SQL 语句分别优化");
            return res;
        }

        List<String> stmts = splitStatements(raw);
        res.put("statements", stmts.size());
        if (stmts.isEmpty() || SqlAstService.stripComments(stmts.get(0)).isBlank()) {
            res.put("ok", false);
            errors.add("SQL 为空（仅含注释）");
            return res;
        }
        if (stmts.size() > 1) {
            warnings.add("检测到 " + stmts.size() + " 条语句，仅对第 1 条进行优化");
        }
        String first = stmts.get(0);
        res.put("sql", first);

        SqlAstService.SqlAnalysis a = ast.analyze(first, dbType, null);
        res.put("stmtType", a.stmtType());

        boolean parsed = tryParse(first, dialect);
        if (!parsed) {
            res.put("ok", false);
            errors.add("SQL 按「" + dbType + "」语法解析失败，请检查括号/引号/关键字");
            String likely = guessDialect(first, dialect);
            if (likely != null) {
                res.put("likelyDialect", likely);
                errors.add("该语句可以按 " + likely + " 语法解析，更像是其它数据库的写法，请确认所选数据库类型是否正确");
            }
        }

        for (String msg : illegalChecks(first, dbType)) {
            res.put("ok", false);
            errors.add(msg);
        }

        String t = a.stmtType();
        if (List.of("INSERT", "UPDATE", "DELETE", "MERGE").contains(t)) {
            warnings.add(t + " 语句：只做规则检查与索引建议，不生成改写 SQL，也不会执行");
        } else if ("DDL".equals(t)) {
            warnings.add("DDL 语句不属于性能优化范围，仅做语法检查");
        } else if ("OTHER".equals(t) || "UNKNOWN".equals(t)) {
            warnings.add("无法识别语句类型，请确认输入的是 SELECT/DML 语句");
        }
        if (List.of("UPDATE", "DELETE").contains(t) && !WHERE.matcher(first).find()) {
            warnings.add(t + " 没有 WHERE 条件，将影响全表数据，请务必确认");
        }
        return res;
    }

    private static boolean tryParse(String sql, DbType dialect) {
        if (dialect == null) {
            return false;
        }
        try {
            List<?> stmts = SQLUtils.parseStatements(trimSql(sql), dialect);
            return stmts != null && !stmts.isEmpty();
        } catch (Throwable e) {
            return false;
        }
    }

    private static String guessDialect(String sql, DbType exclude) {
        List<String> ok = new ArrayList<>();
        for (DbType d : CANDIDATES) {
            if (d == exclude) {
                continue;
            }
            if (tryParse(sql, d)) {
                ok.add(d.name());
            }
        }
        return ok.isEmpty() ? null : String.join(", ", ok);
    }

    private static List<String> splitStatements(String sql) {
        List<String> out = new ArrayList<>();
        StringBuilder cur = new StringBuilder();
        Character q = null;
        for (int i = 0; i < sql.length(); i++) {
            char ch = sql.charAt(i);
            if (q != null) {
                cur.append(ch);
                if (ch == q) {
                    q = null;
                }
            } else if (ch == '\'' || ch == '"' || ch == '`') {
                q = ch;
                cur.append(ch);
            } else if (ch == ';') {
                String t = cur.toString().trim();
                if (!t.isEmpty()) {
                    out.add(t);
                }
                cur.setLength(0);
            } else {
                cur.append(ch);
            }
        }
        String t = cur.toString().trim();
        if (!t.isEmpty()) {
            out.add(t);
        }
        return out;
    }

    private static String normalizeFamily(String dbType) {
        String t = com.dbops.monitor.DbType.normalize(dbType);
        return switch (t) {
            case "POSTGRESQL", "PANWEI" -> "postgres";
            case "SQLSERVER", "MSSQL" -> "tsql";
            case "MYSQL", "GOLDENDB" -> "mysql";
            case "ORACLE", "DAMENG" -> "oracle";
            case "" -> "oracle";
            default -> t.toLowerCase(Locale.ROOT);
        };
    }

    private static String trimSql(String sql) {
        String s = sql == null ? "" : sql.trim();
        while (s.endsWith(";") || s.endsWith("/")) {
            s = s.substring(0, s.length() - 1).trim();
        }
        return s;
    }

    private static List<String> illegalChecks(String sql, String dbType) {
        String fam = normalizeFamily(dbType);
        List<String> errors = new ArrayList<>();
        for (PatternRule r : RULES.getOrDefault(fam, List.of())) {
            if (r.pattern.matcher(sql).find()) {
                errors.add(r.message);
            }
        }
        return errors;
    }

    private record PatternRule(Pattern pattern, String message) {
    }

    private static final Map<String, List<PatternRule>> RULES = buildRules();

    private static Map<String, List<PatternRule>> buildRules() {
        Map<String, List<PatternRule>> m = new LinkedHashMap<>();
        m.put("oracle", List.of(
                pr("(?i)\\bLIMIT\\b", "Oracle 不应使用 MySQL 风格的 LIMIT"),
                pr("(?i)\\bOFFSET\\s+\\d+\\s*,\\s*\\d+", "不应使用 MySQL 风格的 OFFSET,n（双参数）"),
                pr("::\\s*(?:varchar|int|bigint|numeric|number|text|bool)\\b", "不应使用 PostgreSQL 风格的 ::类型 转换"),
                pr("(?i)\\bIFNULL\\s*\\(", "Oracle 不支持 IFNULL()，请用 NVL()/COALESCE()"),
                pr("(?i)\\bTOP\\s+\\d+\\b", "Oracle 不支持 SELECT TOP（请用 FETCH FIRST n ROWS ONLY / ROWNUM）"),
                pr("`[^`]+`", "Oracle 标识符不应使用反引号")
        ));
        m.put("mysql", List.of(
                pr("(?i)\\bROWNUM\\b", "MySQL 不应使用 Oracle 的 ROWNUM"),
                pr("(?i)\\bFETCH\\s+FIRST\\b", "MySQL 不应使用 FETCH FIRST（请用 LIMIT）"),
                pr("(?i)\\bNVL\\s*\\(", "MySQL 不支持 NVL()，请用 IFNULL()/COALESCE()"),
                pr("(?i)\\bSYSDATE\\b(?!\\s*\\()", "MySQL 不支持无括号的 SYSDATE，请用 NOW()/SYSDATE()"),
                pr("(?i)\\(\\+\\)", "MySQL 不支持 Oracle 的 (+) 外连接写法")
        ));
        m.put("postgres", List.of(
                pr("(?i)\\bROWNUM\\b", "PostgreSQL 不应使用 Oracle 的 ROWNUM"),
                pr("(?i)\\bNVL\\s*\\(", "PostgreSQL 不支持 NVL()，请用 COALESCE()"),
                pr("(?i)\\bFROM\\s+DUAL\\b", "PostgreSQL 不需要 FROM DUAL"),
                pr("(?i)\\(\\+\\)", "PostgreSQL 不支持 Oracle 的 (+) 外连接写法")
        ));
        m.put("tsql", List.of(
                pr("(?i)\\bLIMIT\\s+\\d+", "SQL Server 不支持 LIMIT（请用 TOP 或 OFFSET/FETCH）"),
                pr("(?i)\\bROWNUM\\b", "SQL Server 不应使用 Oracle 的 ROWNUM"),
                pr("(?i)\\bFROM\\s+DUAL\\b", "SQL Server 不需要 FROM DUAL")
        ));
        return m;
    }

    private static PatternRule pr(String regex, String msg) {
        return new PatternRule(Pattern.compile(regex), msg);
    }
}