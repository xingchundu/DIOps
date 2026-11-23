package com.dbops.sqlinsight.audit;

import com.alibaba.druid.DbType;
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
 * SQL 优化前静态预检（不连库、不调 Python Agent）。与前端「规则优化」按钮配套，避免强依赖 :8000 预检服务。
 */
@Service
public class SqlPrecheckService {

    private static final Pattern PLSQL = Pattern.compile(
            "(?is)^\\s*(DECLARE|BEGIN|CREATE\\s+(OR\\s+REPLACE\\s+)?(PROCEDURE|FUNCTION|PACKAGE|TRIGGER))\\b");
    private static final String[] DIALECT_TRY = {"oracle", "mysql", "postgresql", "sqlserver"};

    private final SqlAstService ast;

    public SqlPrecheckService(SqlAstService ast) {
        this.ast = ast;
    }

    public Map<String, Object> precheck(String sql, String dbType) {
        String raw = sql == null ? "" : sql.trim();
        String platform = com.dbops.monitor.DbType.normalize(dbType);
        DbType dialect = SqlDialect.of(platform);
        String dialectName = dialect == null ? platform.toLowerCase(Locale.ROOT) : dialect.name().toLowerCase(Locale.ROOT);

        Map<String, Object> res = new LinkedHashMap<>();
        res.put("ok", true);
        res.put("dbType", platform);
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

        SqlAstService.SqlAnalysis a = ast.analyze(first, platform, null);
        res.put("stmtType", a.stmtType());
        if (!a.parsed()) {
            res.put("ok", false);
            errors.add("SQL 按「" + platform + "」语法解析失败，请检查括号/引号/关键字");
            String likely = guessLikelyDialect(first, dialectName);
            if (likely != null) {
                res.put("likelyDialect", likely);
                errors.add("该语句可以按 " + likely + " 语法解析，更像是其它数据库的写法，请确认所选数据库类型是否正确");
            } else if (a.parseError() != null) {
                errors.add(Values.truncate(a.parseError(), 160));
            }
        }

        String t = Values.str(res.get("stmtType"), "OTHER");
        if (List.of("INSERT", "UPDATE", "DELETE", "MERGE").contains(t)) {
            warnings.add(t + " 语句：只做规则检查与索引建议，不生成改写 SQL，也不会执行");
        } else if ("DDL".equals(t)) {
            warnings.add("DDL 语句不属于性能优化范围，仅做语法检查");
        } else if ("OTHER".equals(t) || "UNKNOWN".equals(t)) {
            warnings.add("无法识别语句类型，请确认输入的是 SELECT/DML 语句");
        }
        if (List.of("UPDATE", "DELETE").contains(t) && !first.matches("(?is).*\\bWHERE\\b.*")) {
            warnings.add(t + " 没有 WHERE 条件，将影响全表数据，请务必确认");
        }
        return res;
    }

    private String guessLikelyDialect(String sql, String current) {
        for (String d : DIALECT_TRY) {
            if (d.equals(current)) {
                continue;
            }
            SqlAstService.SqlAnalysis t = ast.analyze(sql, mapFamily(d), null);
            if (t.parsed()) {
                return d;
            }
        }
        return null;
    }

    private static String mapFamily(String d) {
        return switch (d) {
            case "postgresql" -> "POSTGRESQL";
            case "sqlserver" -> "SQLSERVER";
            case "mysql" -> "MYSQL";
            default -> "ORACLE";
        };
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
                continue;
            }
            if (ch == '\'' || ch == '"') {
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
        String tail = cur.toString().trim();
        if (!tail.isEmpty()) {
            out.add(tail);
        }
        return out;
    }
}