package com.dbops.sqlinsight.audit;

import com.dbops.common.BizException;
import com.dbops.common.Values;
import com.dbops.monitor.CmdbInstance;
import com.dbops.monitor.DbType;
import com.dbops.monitor.TargetConnector;
import com.dbops.monitor.TargetDb;
import com.dbops.sqlinsight.ast.SqlAstService;
import org.springframework.stereotype.Service;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * 执行计划 + 目标实例检查（表存在性 / 可执行性 / 全表扫描）。
 * 合并原 sql.js /explain（仅 Oracle）与 services/sqlGovernanceInstanceCheck.js（540 行，5 库）两套实现；
 * 返回结构与原 instanceCheck 完全一致，前端与治理中心无需修改。
 * <p>
 * 安全：只接受单条语句（防止 PG/SQLServer 驱动多语句执行）；EXPLAIN 不带 ANALYZE，不会真正执行 DML。
 */
@Service
public class ExplainService {

    private static final Pattern ORA_FULL = Pattern.compile("TABLE\\s+ACCESS\\s+FULL|FULL\\s+TABLE\\s+SCAN", Pattern.CASE_INSENSITIVE);
    private static final Pattern MY_FULL = Pattern.compile("\\|\\s*ALL\\s*\\||\"access_type\"\\s*:\\s*\"ALL\"|Seq Scan", Pattern.CASE_INSENSITIVE);
    private static final Pattern PG_FULL = Pattern.compile("Seq Scan on", Pattern.CASE_INSENSITIVE);
    private static final Pattern MS_SCAN = Pattern.compile("\\bTable Scan\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern MS_SEEK = Pattern.compile("\\bIndex Seek\\b", Pattern.CASE_INSENSITIVE);

    public static final List<String> FULL_SCAN_HINTS = List.of(
            "执行计划存在全表扫描：请为 WHERE/JOIN 条件列创建或补齐索引",
            "确认过滤条件是否命中索引，避免隐式类型转换导致索引失效",
            "避免 SELECT *，仅查询必要列以降低回表与 IO",
            "大表查询建议评估分区、覆盖索引或 SQL 改写（如 EXISTS 替代 IN）");

    private final TargetConnector connector;
    private final SqlAstService ast;

    public ExplainService(TargetConnector connector, SqlAstService ast) {
        this.connector = connector;
        this.ast = ast;
    }

    public static boolean detectFullScan(String plan, String platformType) {
        if (plan == null || plan.isBlank()) {
            return false;
        }
        return switch (DbType.normalize(platformType)) {
            case DbType.ORACLE, DbType.DAMENG -> ORA_FULL.matcher(plan).find();
            case DbType.MYSQL, DbType.GOLDENDB -> MY_FULL.matcher(plan).find();
            case DbType.POSTGRESQL, DbType.PANWEI -> PG_FULL.matcher(plan).find();
            case DbType.SQLSERVER -> MS_SCAN.matcher(plan).find() && !MS_SEEK.matcher(plan).find();
            default -> ORA_FULL.matcher(plan).find() || PG_FULL.matcher(plan).find();
        };
    }

    static String clean(String sql) {
        String s = sql == null ? "" : sql.trim();
        while (s.endsWith(";")) {
            s = s.substring(0, s.length() - 1).trim();
        }
        return s;
    }

    /** 拒绝多语句（解析失败时按去注释后的分号判断） */
    void requireSingle(String sql, String platformType) {
        SqlAstService.SqlAnalysis a = ast.analyze(sql, platformType, null);
        if (a.parsed() ? a.statements().size() > 1 : SqlAstService.stripComments(sql).replaceAll("'(?:[^']|'')*'", "''").contains(";")) {
            throw BizException.badRequest("一次只能分析一条 SQL 语句");
        }
    }

    private static final java.util.Set<String> EXPLAINABLE = java.util.Set.of("SELECT", "INSERT", "UPDATE", "DELETE", "MERGE");
    /** 以这些词开头的文本不拼到 EXPLAIN 后面：如 PG/磐维 "EXPLAIN " + "ANALYZE DELETE …" 会真正执行 DELETE */
    private static final Pattern UNSAFE_HEAD = Pattern.compile("^\\s*(EXPLAIN|ANALYZE|ANALYSE|SET|EXEC|EXECUTE|CALL|BEGIN|DECLARE|DO|USE|PRAGMA|SHOWPLAN)\\b",
            Pattern.CASE_INSENSITIVE);

    /**
     * 只对 SELECT / INSERT / UPDATE / DELETE / MERGE 取执行计划（SQL Server 只允许 SELECT）；
     * 无法解析的语句只在首关键字是 SELECT/WITH 时放行。返回 null 表示允许，否则为拒绝原因。
     */
    String explainRejectReason(String sql, String platformType) {
        String body = SqlAstService.stripComments(sql).trim();
        if (UNSAFE_HEAD.matcher(body).find()) {
            return "该语句类型不支持获取执行计划";
        }
        SqlAstService.SqlAnalysis a = ast.analyze(sql, platformType, null);
        String type = a.parsed() ? a.stmtType() : (body.matches("(?is)^(SELECT|WITH)\\b.*") ? "SELECT" : "UNPARSED");
        if (DbType.SQLSERVER.equals(DbType.normalize(platformType)) && !"SELECT".equals(type)) {
            return "SQL Server 仅支持查询语句的执行计划";
        }
        if (!EXPLAINABLE.contains(type)) {
            return "UNPARSED".equals(type) ? "语句无法解析，未获取执行计划" : "执行计划仅支持 SELECT / INSERT / UPDATE / DELETE / MERGE";
        }
        return null;
    }

    // ------------------------------------------------------------------ 执行计划

    /** /api/sql/explain 兼容：{plan, issues:[{type, desc}], fullScanDetected, dbType} */
    public Map<String, Object> explain(long instanceId, String sql) {
        String text = clean(sql);
        CmdbInstance inst = connector.fetch(instanceId);
        requireSingle(text, inst.dbType());
        String reject = explainRejectReason(text, inst.dbType());
        if (reject != null) {
            throw BizException.badRequest(reject);
        }
        try (TargetDb db = connector.open(inst)) {
            String plan = runExplain(db, inst.dbType(), text);
            List<Map<String, Object>> issues = new ArrayList<>();
            if (detectFullScan(plan, inst.dbType())) {
                issues.add(Map.of("type", "FULL_SCAN", "desc", "存在全表扫描，建议添加合适索引"));
            }
            if (plan.toUpperCase(Locale.ROOT).split("NESTED LOOPS", -1).length > 3) {
                issues.add(Map.of("type", "NESTED_LOOP", "desc", "多层嵌套循环，可能影响性能"));
            }
            if (plan.toUpperCase(Locale.ROOT).contains("CARTESIAN")) {
                issues.add(Map.of("type", "CARTESIAN", "desc", "笛卡尔积连接，检查WHERE条件是否完整"));
            }
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("plan", plan);
            out.put("issues", issues);
            out.put("fullScanDetected", detectFullScan(plan, inst.dbType()));
            out.put("dbType", inst.dbType());
            return out;
        } catch (SQLException e) {
            throw new BizException(500, "获取执行计划失败: " + e.getMessage());
        }
    }

    String runExplain(TargetDb db, String platformType, String sql) throws SQLException {
        String t = DbType.normalize(platformType);
        Connection c = db.connection();
        return switch (t) {
            case DbType.ORACLE -> "[Oracle] Execution Plan:\n" + "-".repeat(50) + "\n" + explainOracle(c, sql);
            case DbType.DAMENG -> {
                try {
                    yield "[达梦 DM] Execution Plan:\n" + "-".repeat(50) + "\n" + explainOracle(c, sql);
                } catch (SQLException e1) {
                    yield "[达梦 DM] Execution Plan:\n" + "-".repeat(50) + "\n" + table(c, "EXPLAIN " + sql);
                }
            }
            case DbType.MYSQL, DbType.GOLDENDB -> "[" + (DbType.GOLDENDB.equals(t) ? "GoldenDB" : "MySQL") + "] Execution Plan:\n" + table(c, "EXPLAIN " + sql);
            case DbType.POSTGRESQL -> "[PostgreSQL] Execution Plan:\n" + "-".repeat(50) + "\n" + table(c, "EXPLAIN (FORMAT TEXT) " + sql);
            case DbType.PANWEI -> "[PanWei] Execution Plan:\n" + "-".repeat(50) + "\n" + table(c, "EXPLAIN " + sql);
            case DbType.SQLSERVER -> "[SQL Server] Execution Plan:\n" + "-".repeat(50) + "\n" + explainSqlServer(c, sql);
            default -> throw new SQLException("不支持 EXPLAIN 的数据库类型: " + platformType);
        };
    }

    private String explainOracle(Connection c, String sql) throws SQLException {
        String id = "DIOPS_" + Long.toString(System.nanoTime(), 36).toUpperCase(Locale.ROOT);
        try (Statement st = c.createStatement()) {
            st.setQueryTimeout(30);
            st.execute("EXPLAIN PLAN SET STATEMENT_ID = '" + id + "' FOR " + sql);
            StringBuilder sb = new StringBuilder();
            try (ResultSet rs = st.executeQuery("SELECT PLAN_TABLE_OUTPUT FROM TABLE(DBMS_XPLAN.DISPLAY('PLAN_TABLE', '" + id + "', 'ALL'))")) {
                while (rs.next()) {
                    sb.append(rs.getString(1)).append('\n');
                }
            }
            try {
                st.execute("DELETE FROM PLAN_TABLE WHERE STATEMENT_ID = '" + id + "'");
                if (!c.getAutoCommit()) {
                    c.commit();
                }
            } catch (SQLException ignore) {
                // PLAN_TABLE 为会话级临时表时无需清理
            }
            return sb.length() == 0 ? "执行计划为空" : sb.toString();
        }
    }

    private String explainSqlServer(Connection c, String sql) throws SQLException {
        try (Statement st = c.createStatement()) {
            st.execute("SET SHOWPLAN_TEXT ON");
            try {
                StringBuilder sb = new StringBuilder();
                boolean rsNext = st.execute(sql);
                while (true) {
                    if (rsNext) {
                        try (ResultSet rs = st.getResultSet()) {
                            while (rs.next()) {
                                sb.append(rs.getString(1)).append('\n');
                            }
                        }
                    } else if (st.getUpdateCount() == -1) {
                        break;
                    }
                    rsNext = st.getMoreResults();
                }
                return sb.length() == 0 ? "(无计划输出)" : sb.toString();
            } finally {
                try {
                    st.execute("SET SHOWPLAN_TEXT OFF");
                } catch (SQLException ignore) {
                    // ignore
                }
            }
        }
    }

    private String table(Connection c, String sql) throws SQLException {
        try (Statement st = c.createStatement()) {
            st.setQueryTimeout(30);
            try (ResultSet rs = st.executeQuery(sql)) {
                ResultSetMetaData md = rs.getMetaData();
                int n = md.getColumnCount();
                List<String> lines = new ArrayList<>();
                if (n > 1) {
                    List<String> head = new ArrayList<>();
                    for (int i = 1; i <= n; i++) {
                        head.add(md.getColumnLabel(i));
                    }
                    lines.add(String.join(" | ", head));
                    lines.add("-".repeat(40));
                }
                while (rs.next()) {
                    List<String> cells = new ArrayList<>();
                    for (int i = 1; i <= n; i++) {
                        Object v = rs.getObject(i);
                        cells.add(v == null ? "NULL" : String.valueOf(v));
                    }
                    lines.add(String.join(" | ", cells));
                }
                return String.join("\n", lines);
            }
        }
    }

    // ------------------------------------------------------------------ 实例检查（审核用）

    /** 表存在性 + 可执行性 + 执行计划；结构同原 sanitizeInstanceCheck */
    public Map<String, Object> instanceCheck(long instanceId, String sql, List<String> tables, String stmtType) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("instanceId", instanceId);
        out.put("instanceName", null);
        out.put("dbType", null);
        out.put("connected", false);
        out.put("connectionError", null);
        out.put("tables", List.of());
        out.put("tableNote", null);
        out.put("executable", null);
        out.put("executeMessage", null);
        out.put("explainSupported", false);
        out.put("explainOk", false);
        out.put("explainPlan", "");
        out.put("fullScanDetected", false);
        out.put("optimizeSuggestions", List.of());
        String text = clean(sql);
        CmdbInstance inst;
        try {
            inst = connector.fetch(instanceId);
        } catch (Exception e) {
            out.put("connectionError", e.getMessage());
            out.put("executable", false);
            out.put("executeMessage", e.getMessage());
            return out;
        }
        out.put("instanceName", inst.instanceName());
        out.put("dbType", inst.dbType());
        try (TargetDb db = connector.open(inst)) {
            out.put("connected", true);
            List<Map<String, Object>> tl = new ArrayList<>();
            for (String full : tables) {
                tl.add(checkTable(db, inst.dbType(), full));
            }
            out.put("tables", tl);
            if (tables.isEmpty()) {
                out.put("tableNote", "未从 SQL 中识别到表名（如 SELECT 1、仅函数调用等）");
            }
            boolean explainable = "SELECT".equals(stmtType);
            boolean multi = false;
            try {
                requireSingle(text, inst.dbType());
            } catch (BizException e) {
                multi = true;
            }
            if (multi) {
                out.put("executable", false);
                out.put("executeMessage", "包含多条语句，请逐条审核");
                out.put("explainPlan", "包含多条语句，未获取执行计划");
                return out;
            }
            if ("DDL".equals(stmtType) || "DCL".equals(stmtType)) {
                out.put("executeMessage", "DDL/DCL 不做 EXPLAIN 探测，请在发布环节验证");
                out.put("explainPlan", "执行计划仅支持 SELECT / WITH 语句");
                return out;
            }
            String reject = explainRejectReason(text, inst.dbType());
            if (reject != null) {
                out.put("executeMessage", reject + "，请在发布环节验证");
                out.put("explainPlan", reject);
                return out;
            }
            try {
                String plan = runExplain(db, inst.dbType(), text);
                out.put("executable", true);
                out.put("executeMessage", explainable ? "SELECT 语句 EXPLAIN 成功" : "语句已通过 EXPLAIN 语法检查");
                if (explainable) {
                    boolean full = detectFullScan(plan, inst.dbType());
                    out.put("explainSupported", true);
                    out.put("explainOk", true);
                    out.put("explainPlan", plan);
                    out.put("fullScanDetected", full);
                    out.put("optimizeSuggestions", full ? FULL_SCAN_HINTS : List.of());
                } else {
                    out.put("explainPlan", "执行计划仅支持 SELECT / WITH 语句；当前语句已通过语法检查");
                }
            } catch (SQLException e) {
                out.put("executable", false);
                out.put("executeMessage", "EXPLAIN 失败: " + e.getMessage());
                out.put("explainSupported", explainable);
                out.put("explainPlan", "获取执行计划失败: " + e.getMessage());
            }
        } catch (Exception e) {
            out.put("connected", false);
            out.put("connectionError", e.getMessage());
            out.put("executable", false);
            out.put("executeMessage", e.getMessage());
            out.put("explainPlan", e.getMessage());
        }
        return out;
    }

    Map<String, Object> checkTable(TargetDb db, String platformType, String full) {
        String schema = null;
        String name = full;
        int dot = full.lastIndexOf('.');
        if (dot > 0) {
            schema = full.substring(0, dot).replace("\"", "").replace("`", "");
            name = full.substring(dot + 1);
        }
        name = name.replace("\"", "").replace("`", "").replace("[", "").replace("]", "");
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("schema", schema);
        m.put("name", name);
        String t = DbType.normalize(platformType);
        String q = switch (t) {
            case DbType.ORACLE, DbType.DAMENG -> "SELECT COUNT(*) AS C FROM ALL_TABLES WHERE OWNER = NVL(?, SYS_CONTEXT('USERENV','CURRENT_SCHEMA')) AND TABLE_NAME = ?";
            case DbType.MYSQL, DbType.GOLDENDB -> "SELECT COUNT(*) AS C FROM information_schema.tables WHERE table_schema = IFNULL(?, DATABASE()) AND table_name = ?";
            case DbType.POSTGRESQL, DbType.PANWEI -> "SELECT COUNT(*) AS C FROM information_schema.tables WHERE table_schema = COALESCE(LOWER(?), current_schema()) "
                    + "AND table_name = LOWER(?)";
            case DbType.SQLSERVER -> "SELECT COUNT(*) AS C FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ISNULL(?, 'dbo') AND TABLE_NAME = ?";
            default -> null;
        };
        if (q == null) {
            m.put("exists", false);
            m.put("message", "未知库类型");
            return m;
        }
        String sch = schema;
        String tbl = name;
        if (DbType.ORACLE.equals(t) || DbType.DAMENG.equals(t)) {
            sch = schema == null ? null : schema.toUpperCase(Locale.ROOT);
            tbl = name.toUpperCase(Locale.ROOT);
        }
        try {
            Map<String, Object> r = db.one(q, sch, tbl);
            boolean exists = r != null && Values.toLong(r.get("C"), 0) > 0;
            // 视图/同义词也视为存在（Oracle/DM）
            if (!exists && (DbType.ORACLE.equals(t) || DbType.DAMENG.equals(t))) {
                Map<String, Object> v = db.oneQuietly("SELECT COUNT(*) AS C FROM ALL_OBJECTS WHERE OWNER IN (NVL(?, SYS_CONTEXT('USERENV','CURRENT_SCHEMA')), 'PUBLIC') "
                        + "AND OBJECT_NAME = ? AND OBJECT_TYPE IN ('VIEW', 'SYNONYM', 'MATERIALIZED VIEW')", sch, tbl);
                exists = v != null && Values.toLong(v.get("C"), 0) > 0;
            }
            m.put("exists", exists);
            m.put("message", exists ? "表存在" : "表不存在");
        } catch (SQLException e) {
            m.put("exists", false);
            m.put("message", "检查失败: " + e.getMessage());
        }
        return m;
    }

    /** 审核时需要元数据：开一个连接交给回调 */
    public <T> T withConnection(long instanceId, java.util.function.Function<TargetDb, T> fn) throws SQLException {
        try (TargetDb db = connector.open(instanceId)) {
            return fn.apply(db);
        }
    }
}
