package com.dbops.sqlinsight.store;

import com.dbops.common.Db;
import com.dbops.common.Values;
import com.dbops.monitor.DbType;
import com.dbops.sqlinsight.ast.SqlDialect;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * CMDB 实例目录（SQL 洞察视角）：采集范围 = 已纳管、受支持类型、未停用的实例；
 * 业务类型取 CMDB_INSTANCE.SQL_BIZ_TYPE（OLTP/BATCH/REPORT，空为 OLTP），用于规则阈值覆盖。
 */
@Component
public class InstanceDirectory {

    public static final Set<String> BIZ_TYPES = Set.of("OLTP", "BATCH", "REPORT");

    public record Inst(long id, String name, String dbType, String family, String bizType, String status) {
    }

    private final Db db;
    private volatile Map<Long, Inst> cache = Map.of();
    private volatile long loadedAt;

    public InstanceDirectory(Db db) {
        this.db = db;
    }

    public synchronized void reload() {
        List<Map<String, Object>> rows;
        try {
            rows = db.query("SELECT INSTANCE_ID, INSTANCE_NAME, DB_TYPE, STATUS, SQL_BIZ_TYPE FROM CMDB_INSTANCE");
        } catch (Exception e) {
            if (!Db.isMissingColumn(e)) {
                throw e;
            }
            rows = db.query("SELECT INSTANCE_ID, INSTANCE_NAME, DB_TYPE, STATUS, NULL AS SQL_BIZ_TYPE FROM CMDB_INSTANCE");
        }
        Map<Long, Inst> m = new ConcurrentHashMap<>();
        for (Map<String, Object> r : rows) {
            long id = Values.toLong(r.get("INSTANCE_ID"), 0);
            String t = DbType.normalize(r.get("DB_TYPE"));
            String biz = Values.str(r.get("SQL_BIZ_TYPE"), "OLTP").toUpperCase();
            m.put(id, new Inst(id, Values.str(r.get("INSTANCE_NAME"), "#" + id), t, SqlDialect.family(t),
                    BIZ_TYPES.contains(biz) ? biz : "OLTP", Values.str(r.get("STATUS"), "UNKNOWN")));
        }
        cache = m;
        loadedAt = System.currentTimeMillis();
    }

    private volatile long lastMissReload;

    public Inst get(long id) {
        long now = System.currentTimeMillis();
        if (now - loadedAt > 60_000) {
            reload();
        } else if (!cache.containsKey(id) && now - lastMissReload > 5_000) {
            // 新加的实例要能立刻查到，但不存在的 ID 不能每次都触发全表 reload（可被外部请求放大成平台库压力）：未命中最多 5 秒刷新一次
            lastMissReload = now;
            reload();
        }
        return cache.get(id);
    }

    /** 本节点负责采集的实例（按实例 ID 取模分片，多节点部署时用 SQLINSIGHT_SHARD_INDEX / SQLINSIGHT_SHARD_COUNT） */
    public List<Inst> collectable() {
        if (System.currentTimeMillis() - loadedAt > 60_000) {
            reload();
        }
        int count = Math.max(1, Values.toInt(configured("SQLINSIGHT_SHARD_COUNT"), 1));
        int index = Math.floorMod(Values.toInt(configured("SQLINSIGHT_SHARD_INDEX"), 0), count);
        List<Inst> out = new ArrayList<>();
        for (Inst i : cache.values()) {
            if (DbType.isMonitored(i.dbType()) && !"STOPPED".equalsIgnoreCase(i.status())
                    && Math.floorMod(i.id(), count) == index) {
                out.add(i);
            }
        }
        return out;
    }

    /** .env 经 EnvFileLoader 进系统属性，不一定在进程环境变量里。 */
    private static String configured(String key) {
        String v = System.getenv(key);
        if (v == null || v.isBlank()) {
            v = System.getProperty(key);
        }
        return v == null || v.isBlank() ? null : v.trim();
    }
}
