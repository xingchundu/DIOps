package com.dbops.service;

import com.dbops.common.Db;
import com.dbops.common.Values;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * SYS_CONFIG 读取 + 内存缓存（同 Node services/systemConfig.js）。
 * [fix] Node 版 loadAll 失败后 loaded 一直为 false，此后每次 get 都会再查库；这里失败后 60s 内不重复尝试。
 */
@Service
public class SystemConfigService {

    private static final Logger log = LoggerFactory.getLogger(SystemConfigService.class);
    private static final long RETRY_MS = 60_000;

    private final Db db;
    private volatile Map<String, String> cache = new ConcurrentHashMap<>();
    private volatile boolean loaded = false;
    private volatile long lastAttempt = 0;

    public SystemConfigService(Db db) {
        this.db = db;
    }

    public synchronized void loadAll() {
        lastAttempt = System.currentTimeMillis();
        try {
            Map<String, String> next = new ConcurrentHashMap<>();
            for (Map<String, Object> row : db.query("SELECT CONFIG_KEY, CONFIG_VALUE FROM SYS_CONFIG")) {
                String k = Values.str(row.get("CONFIG_KEY"));
                Object v = row.get("CONFIG_VALUE");
                if (k != null && v != null) {
                    next.put(k, String.valueOf(v));
                }
            }
            cache = next;
            loaded = true;
        } catch (Exception e) {
            if (Db.isMissingTable(e)) {
                log.warn("[system-config] SYS_CONFIG 表不存在，请执行 migration_system_config.sql");
            } else {
                log.warn("[system-config] loadAll error: {}", e.getMessage());
            }
        }
    }

    private void ensureLoaded() {
        if (!loaded && System.currentTimeMillis() - lastAttempt > RETRY_MS) {
            loadAll();
        }
    }

    public String get(String key, String fallback) {
        ensureLoaded();
        String v = cache.get(key);
        return (v == null || v.isEmpty()) ? fallback : v;
    }

    public double getNumber(String key, double fallback) {
        Double d = Values.toDouble(get(key, null));
        return d == null ? fallback : d;
    }

    public long getLong(String key, long fallback) {
        return (long) getNumber(key, fallback);
    }

    public boolean getBool(String key, boolean fallback) {
        String v = get(key, null);
        return v == null ? fallback : Values.truthy(v);
    }

    public void set(String key, String value, Long userId) {
        db.update("UPDATE SYS_CONFIG SET CONFIG_VALUE=?, UPDATED_BY=?, UPDATED_AT=SYSTIMESTAMP WHERE CONFIG_KEY=?",
                value, userId, key);
        cache.put(key, value);
    }

    public List<Map<String, Object>> getAll() {
        ensureLoaded();
        try {
            return db.query("SELECT CONFIG_KEY, CONFIG_VALUE, DEFAULT_VALUE, CATEGORY, LABEL, DESCRIPTION, VALUE_TYPE, "
                    + "MIN_VAL, MAX_VAL, OPTIONS, UPDATED_AT FROM SYS_CONFIG ORDER BY CATEGORY, CONFIG_ID");
        } catch (Exception e) {
            return Collections.emptyList();
        }
    }

    public boolean reset(String key, Long userId) {
        Map<String, Object> r = db.one("SELECT DEFAULT_VALUE FROM SYS_CONFIG WHERE CONFIG_KEY=?", key);
        if (r != null && r.get("DEFAULT_VALUE") != null) {
            set(key, String.valueOf(r.get("DEFAULT_VALUE")), userId);
            return true;
        }
        return false;
    }
}
