package com.dbops.monitor;

import com.dbops.common.RowNormalizer;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;
import java.util.Map;

/**
 * 被管库连接（单连接，用完即关）。查询结果列名统一大写。
 */
public final class TargetDb implements AutoCloseable {

    private static final int DEFAULT_MAX_ROWS = 5000;

    private final Connection conn;
    private final String dbType;
    private final int queryTimeoutSec;

    public TargetDb(Connection conn, String dbType, int queryTimeoutSec) {
        this.conn = conn;
        this.dbType = dbType;
        this.queryTimeoutSec = queryTimeoutSec;
    }

    public String dbType() {
        return dbType;
    }

    public Connection connection() {
        return conn;
    }

    public List<Map<String, Object>> query(String sql, Object... args) throws SQLException {
        return queryMax(DEFAULT_MAX_ROWS, sql, args);
    }

    public List<Map<String, Object>> queryMax(int maxRows, String sql, Object... args) throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            if (queryTimeoutSec > 0) {
                ps.setQueryTimeout(queryTimeoutSec);
            }
            if (maxRows > 0) {
                ps.setMaxRows(maxRows);
            }
            for (int i = 0; i < args.length; i++) {
                ps.setObject(i + 1, args[i]);
            }
            try (ResultSet rs = ps.executeQuery()) {
                return RowNormalizer.readAll(rs, maxRows);
            }
        }
    }

    public Map<String, Object> one(String sql, Object... args) throws SQLException {
        List<Map<String, Object>> rows = queryMax(1, sql, args);
        return rows.isEmpty() ? null : rows.get(0);
    }

    /** 查询失败返回 null（对应 Node 里大量 try { ... } catch { ignore }） */
    public Map<String, Object> oneQuietly(String sql, Object... args) {
        try {
            return one(sql, args);
        } catch (SQLException e) {
            return null;
        }
    }

    public List<Map<String, Object>> queryQuietly(String sql, Object... args) {
        try {
            return query(sql, args);
        } catch (SQLException e) {
            return null;
        }
    }

    /** 与 queryQuietly 相同，但失败时返回空列表（供直接 for-each 的调用方使用，避免 NPE） */
    public List<Map<String, Object>> queryOrEmpty(String sql, Object... args) {
        List<Map<String, Object>> r = queryQuietly(sql, args);
        return r == null ? List.of() : r;
    }

    public void execute(String sql) throws SQLException {
        try (Statement st = conn.createStatement()) {
            if (queryTimeoutSec > 0) {
                st.setQueryTimeout(queryTimeoutSec);
            }
            st.execute(sql);
        }
    }

    @Override
    public void close() {
        try {
            conn.close();
        } catch (SQLException ignore) {
            // ignore
        }
    }
}
