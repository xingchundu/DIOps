package com.dbops.sqlinsight.ast;

import com.alibaba.druid.DbType;
import com.alibaba.druid.sql.SQLUtils;
import com.alibaba.druid.sql.ast.SQLStatement;
import com.alibaba.druid.sql.ast.statement.SQLDDLStatement;
import com.alibaba.druid.sql.ast.statement.SQLDeleteStatement;
import com.alibaba.druid.sql.ast.statement.SQLGrantStatement;
import com.alibaba.druid.sql.ast.statement.SQLInsertStatement;
import com.alibaba.druid.sql.ast.statement.SQLMergeStatement;
import com.alibaba.druid.sql.ast.statement.SQLRevokeStatement;
import com.alibaba.druid.sql.ast.statement.SQLSelectStatement;
import com.alibaba.druid.sql.ast.statement.SQLTruncateStatement;
import com.alibaba.druid.sql.ast.statement.SQLUpdateStatement;
import com.alibaba.druid.sql.visitor.ParameterizedOutputVisitorUtils;
import com.alibaba.druid.sql.visitor.SchemaStatVisitor;
import com.alibaba.druid.stat.TableStat;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * 唯一的 SQL 解析入口（Druid AST）：解析、归一化指纹、语句分类、表提取。
 * <p>
 * 取代原先分散的实现：sql.js / sqlWorkbench.js 的 isDangerous 正则、sqlGovernanceInstanceCheck.extractTableRefs 正则、
 * 三套互不相认的 SQL hash（md5 / sha256 截断 / SQL_ID）。
 */
@Service
public class SqlAstService {

    public static final Set<String> DANGEROUS_TYPES = Set.of("INSERT", "UPDATE", "DELETE", "MERGE", "DDL", "DCL");

    private static final Pattern BLOCK_COMMENT = Pattern.compile("/\\*(?!\\+).*?\\*/", Pattern.DOTALL);
    private static final Pattern LINE_COMMENT = Pattern.compile("--[^\\r\\n]*");
    private static final Pattern WS = Pattern.compile("\\s+");
    private static final Pattern STR_LIT = Pattern.compile("'(?:[^']|'')*'");
    private static final Pattern NUM_LIT = Pattern.compile("(?<![\\w$.:@])-?\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?(?![\\w$])", Pattern.CASE_INSENSITIVE);
    private static final Pattern ORA_BIND = Pattern.compile("(?<![\\w:]):(?:\\w+|\\d+)");
    private static final Pattern PG_BIND = Pattern.compile("\\$\\d+");
    private static final Pattern MSSQL_BIND = Pattern.compile("(?<!@)@(?!@)\\w+");
    private static final Pattern IN_LIST = Pattern.compile("\\bin\\s*\\(\\s*\\?(?:\\s*,\\s*\\?)+\\s*\\)");
    private static final Pattern VALUES_ROWS = Pattern.compile("(\\(\\s*\\?(?:\\s*,\\s*\\?)*\\s*\\))(?:\\s*,\\s*\\(\\s*\\?(?:\\s*,\\s*\\?)*\\s*\\))+");
    private static final Pattern MYSQL_DIGEST_ELLIPSIS = Pattern.compile("\\(\\s*\\.\\.\\.\\s*\\)");
    private static final Pattern FIRST_WORD = Pattern.compile("^\\s*(\\w+)");

    /** 解析 + 指纹结果 */
    public record SqlAnalysis(String dbFamily, String schema, String fingerprint, String normalized, String stmtType,
                              List<String> tables, boolean parsed, String parseError, DbType dialect,
                              List<SQLStatement> statements) {
    }

    public SqlAnalysis analyze(String sql, String platformType, String schema) {
        String family = SqlDialect.family(platformType);
        String sch = normalizeSchema(schema);
        String text = preprocess(sql);
        DbType dialect = SqlDialect.of(platformType);
        List<SQLStatement> stmts = null;
        String err = null;
        DbType used = dialect;
        List<DbType> tries = dialect != null ? List.of(dialect) : SqlDialect.guessOrder();
        for (DbType d : tries) {
            try {
                stmts = SQLUtils.parseStatements(text, d);
                used = d;
                err = null;
                break;
            } catch (Throwable e) {
                err = shortMsg(e);
            }
        }
        if (stmts == null || stmts.isEmpty()) {
            String norm = fallbackNormalize(text);
            return new SqlAnalysis(family, sch, hash(family, sch, norm), norm, firstWordType(text), List.of(), false,
                    err == null ? "空语句" : err, used, List.of());
        }
        String parameterized;
        try {
            parameterized = ParameterizedOutputVisitorUtils.parameterize(stmts, used);
        } catch (Throwable e) {
            parameterized = text;
        }
        String norm = finishNormalize(parameterized);
        Set<String> tables = new LinkedHashSet<>();
        try {
            for (SQLStatement st : stmts) {
                SchemaStatVisitor v = SQLUtils.createSchemaStatVisitor(used);
                st.accept(v);
                for (Map.Entry<TableStat.Name, TableStat> e : v.getTables().entrySet()) {
                    tables.add(e.getKey().getName());
                }
            }
        } catch (Throwable ignore) {
            // 表提取失败不影响指纹
        }
        return new SqlAnalysis(family, sch, hash(family, sch, norm), norm, stmtType(stmts.get(0)), new ArrayList<>(tables),
                true, null, used, stmts);
    }

    /** 语句分类（危险语句拦截用）：返回每条语句的类型；解析失败时按首关键字保守判断 */
    public List<String> classify(String sql, String platformType) {
        SqlAnalysis a = analyze(sql, platformType, null);
        List<String> out = new ArrayList<>();
        if (a.parsed()) {
            for (SQLStatement st : a.statements()) {
                out.add(stmtType(st));
            }
            return out;
        }
        // 解析失败：剥离注释后逐条按首关键字判断；任何一段含危险关键字都按危险处理
        String clean = stripComments(sql);
        for (String part : clean.split(";")) {
            if (!part.isBlank()) {
                out.add(firstWordType(part));
            }
        }
        if (out.isEmpty()) {
            out.add("OTHER");
        }
        return out;
    }

    /** 返回第一个危险语句类型；null 表示只读 */
    public String dangerousType(String sql, String platformType) {
        for (String t : classify(sql, platformType)) {
            if (DANGEROUS_TYPES.contains(t)) {
                return t;
            }
            if ("UNKNOWN".equals(t)) {
                return "UNKNOWN";
            }
        }
        return null;
    }

    public static String stmtType(SQLStatement st) {
        if (st instanceof SQLSelectStatement) {
            return "SELECT";
        }
        if (st instanceof SQLInsertStatement) {
            return "INSERT";
        }
        if (st instanceof SQLUpdateStatement) {
            return "UPDATE";
        }
        if (st instanceof SQLDeleteStatement) {
            return "DELETE";
        }
        if (st instanceof SQLMergeStatement) {
            return "MERGE";
        }
        if (st instanceof SQLDDLStatement || st instanceof SQLTruncateStatement) {
            return "DDL";
        }
        if (st instanceof SQLGrantStatement || st instanceof SQLRevokeStatement) {
            return "DCL";
        }
        String cn = st.getClass().getSimpleName().toUpperCase(Locale.ROOT);
        if (cn.contains("EXPLAIN") || cn.contains("SHOW") || cn.contains("DESC") || cn.contains("SETSTATEMENT")
                || cn.contains("USE")) {
            return "OTHER";
        }
        if (cn.contains("CALL") || cn.contains("EXEC") || cn.contains("BLOCK") || cn.contains("PROCEDURE")) {
            // 存储过程 / 匿名块：内部可能有任意写操作
            return "UNKNOWN";
        }
        return "OTHER";
    }

    static String firstWordType(String sql) {
        var m = FIRST_WORD.matcher(stripComments(sql));
        if (!m.find()) {
            return "OTHER";
        }
        String w = m.group(1).toUpperCase(Locale.ROOT);
        return switch (w) {
            case "SELECT", "WITH" -> "SELECT";
            case "INSERT", "REPLACE" -> "INSERT";
            case "UPDATE" -> "UPDATE";
            case "DELETE" -> "DELETE";
            case "MERGE", "UPSERT" -> "MERGE";
            case "CREATE", "ALTER", "DROP", "TRUNCATE", "RENAME", "COMMENT" -> "DDL";
            case "GRANT", "REVOKE" -> "DCL";
            case "EXPLAIN", "SHOW", "DESC", "DESCRIBE", "SET", "USE" -> "OTHER";
            default -> "UNKNOWN";
        };
    }

    // ------------------------------------------------------------- 归一化

    static String preprocess(String sql) {
        String s = sql == null ? "" : sql.trim();
        // MySQL DIGEST_TEXT 把 IN 列表写成 (...)，无法解析
        s = MYSQL_DIGEST_ELLIPSIS.matcher(s).replaceAll("(?)");
        while (s.endsWith(";") || s.endsWith("/")) {
            s = s.substring(0, s.length() - 1).trim();
        }
        return s;
    }

    public static String stripComments(String sql) {
        String s = sql == null ? "" : sql;
        s = BLOCK_COMMENT.matcher(s).replaceAll(" ");
        return LINE_COMMENT.matcher(s).replaceAll(" ");
    }

    /** 解析失败时的文本归一化：去注释、字面量 → ?、绑定变量 → ?、压缩空白、小写 */
    static String fallbackNormalize(String sql) {
        String s = stripComments(sql);
        s = STR_LIT.matcher(s).replaceAll("?");
        s = NUM_LIT.matcher(s).replaceAll("?");
        return finishNormalize(s);
    }

    static String finishNormalize(String s) {
        String n = s;
        n = ORA_BIND.matcher(n).replaceAll("?");
        n = PG_BIND.matcher(n).replaceAll("?");
        n = MSSQL_BIND.matcher(n).replaceAll("?");
        n = n.replace("`", "");
        n = WS.matcher(n).replaceAll(" ").trim().toLowerCase(Locale.ROOT);
        n = n.replace("( ", "(").replace(" )", ")").replace(" ,", ",");
        n = IN_LIST.matcher(n).replaceAll("in (?)");
        n = VALUES_ROWS.matcher(n).replaceAll("$1");
        return n;
    }

    static String normalizeSchema(String schema) {
        if (schema == null || schema.isBlank()) {
            return "-";
        }
        return schema.trim().replace("\"", "").replace("`", "").toUpperCase(Locale.ROOT);
    }

    static String hash(String family, String schema, String normalized) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] d = md.digest((family + "\n" + schema + "\n" + normalized).getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 16; i++) {
                sb.append(String.format("%02x", d[i]));
            }
            return sb.toString();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static String shortMsg(Throwable e) {
        String m = String.valueOf(e.getMessage());
        return m.length() > 300 ? m.substring(0, 300) : m;
    }
}
