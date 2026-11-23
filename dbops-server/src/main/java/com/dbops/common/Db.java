package com.dbops.common;

import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;

/**
 * 平台库（Oracle）访问封装，基于 JdbcTemplate。所有 SQL 使用 ? 位置参数。
 * <p>
 * 与 Node 版 db.execute/queryPage 对应，但修复了：
 * <ul>
 *   <li>分页参数字符串拼接（page=2 返回 2000 行）与 SQL 注入：页码/页大小转整数并作为绑定变量</li>
 *   <li>重复占位符位置绑定导致 NJS-098：JDBC 的 ? 天然一一对应</li>
 * </ul>
 */
@Component
public class Db {

    public static final int MAX_PAGE_SIZE = 500;

    private final JdbcTemplate jdbc;
    private final TransactionTemplate tx;

    private static final RowMapper<Map<String, Object>> ROW_MAPPER = (rs, i) -> RowNormalizer.readRow(rs);

    public Db(JdbcTemplate jdbc, TransactionTemplate tx) {
        this.jdbc = jdbc;
        this.tx = tx;
    }

    public JdbcTemplate jdbc() {
        return jdbc;
    }

    public List<Map<String, Object>> query(String sql, Object... args) {
        return jdbc.query(sql, ROW_MAPPER, args);
    }

    public List<Map<String, Object>> query(String sql, List<?> args) {
        return jdbc.query(sql, ROW_MAPPER, args.toArray());
    }

    public Map<String, Object> one(String sql, Object... args) {
        List<Map<String, Object>> rows = query(sql, args);
        return rows.isEmpty() ? null : rows.get(0);
    }

    public long count(String sql, Object... args) {
        Map<String, Object> r = one(sql, args);
        if (r == null || r.isEmpty()) {
            return 0;
        }
        return Values.toLong(r.values().iterator().next(), 0);
    }

    public int update(String sql, Object... args) {
        return jdbc.update(sql, args);
    }

    public int update(String sql, List<?> args) {
        return jdbc.update(sql, args.toArray());
    }

    /** INSERT 并取回 IDENTITY 主键（Oracle 需显式指定列名） */
    public Long insertReturningId(String sql, String idColumn, Object... args) {
        return jdbc.execute((java.sql.Connection con) -> {
            try (PreparedStatement ps = con.prepareStatement(sql, new String[]{idColumn})) {
                for (int i = 0; i < args.length; i++) {
                    setParam(ps, i + 1, args[i]);
                }
                ps.executeUpdate();
                try (ResultSet keys = ps.getGeneratedKeys()) {
                    if (keys != null && keys.next()) {
                        return Values.toLong(keys.getObject(1));
                    }
                }
                return null;
            }
        });
    }

    /** 忽略异常的写操作（审计日志等“尽力而为”场景，对应 Node 的 .catch(() => {})） */
    public void updateQuietly(String sql, Object... args) {
        try {
            jdbc.update(sql, args);
        } catch (DataAccessException ignore) {
            // best effort
        }
    }

    public <T> T inTx(Supplier<T> work) {
        return tx.execute(status -> work.get());
    }

    public void inTx(Runnable work) {
        tx.executeWithoutResult(status -> work.run());
    }

    /**
     * Oracle ROWNUM 分页，返回 {total, page, size, list}（与 Node 版 queryPage 返回结构一致）。
     */
    public Map<String, Object> queryPage(String sql, List<?> args, Object page, Object size) {
        int p = Values.clamp(Values.toInt(page, 1), 1, 1_000_000);
        int s = Values.clamp(Values.toInt(size, 20), 1, MAX_PAGE_SIZE);
        long offset = (long) (p - 1) * s;
        long total = count("SELECT COUNT(*) AS TOTAL FROM (" + sql + ")", args.toArray());
        List<Object> pageArgs = new ArrayList<>(args);
        pageArgs.add(offset + s);
        pageArgs.add(offset);
        List<Map<String, Object>> list = query(
                "SELECT * FROM (SELECT t.*, ROWNUM RN FROM (" + sql + ") t WHERE ROWNUM <= ?) WHERE RN > ?",
                pageArgs);
        return R.map("total", total, "page", p, "size", s, "list", list);
    }

    public Map<String, Object> queryPage(String sql, Object page, Object size) {
        return queryPage(sql, Collections.emptyList(), page, size);
    }

    /** 生成 "?, ?, ?" */
    public static String placeholders(int n) {
        if (n <= 0) {
            throw new IllegalArgumentException("IN 列表不能为空");
        }
        String[] a = new String[n];
        Arrays.fill(a, "?");
        return String.join(",", a);
    }

    public static boolean isMissingTable(Throwable e) {
        return messageContains(e, "ORA-00942");
    }

    public static boolean isMissingColumn(Throwable e) {
        return messageContains(e, "ORA-00904");
    }

    public static boolean isUniqueViolation(Throwable e) {
        return messageContains(e, "ORA-00001");
    }

    public static boolean isDeadlock(Throwable e) {
        return messageContains(e, "ORA-00060");
    }

    public static boolean messageContains(Throwable e, String token) {
        for (Throwable t = e; t != null; t = t.getCause()) {
            if (t.getMessage() != null && t.getMessage().contains(token)) {
                return true;
            }
            if (t.getCause() == t) {
                break;
            }
        }
        return false;
    }

    static void setParam(PreparedStatement ps, int idx, Object v) throws java.sql.SQLException {
        if (v == null) {
            ps.setNull(idx, java.sql.Types.VARCHAR);
        } else if (v instanceof String s && s.length() > 4000) {
            // Oracle JDBC：超长字符串绑到 CLOB 列须用 setClob，否则 ORA-01461 导致工单等写入失败
            ps.setClob(idx, new javax.sql.rowset.serial.SerialClob(s.toCharArray()));
        } else if (v instanceof java.util.Date d && !(v instanceof java.sql.Timestamp)) {
            ps.setTimestamp(idx, new java.sql.Timestamp(d.getTime()));
        } else {
            ps.setObject(idx, v);
        }
    }
}
