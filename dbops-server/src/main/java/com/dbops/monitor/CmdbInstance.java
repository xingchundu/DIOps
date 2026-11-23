package com.dbops.monitor;

import com.dbops.common.Values;

import java.util.Map;

/**
 * 被管实例连接信息（CMDB_INSTANCE 一行）。
 */
public record CmdbInstance(long instanceId, String instanceName, String hostIp, int port, String sid,
                           String serviceName, String dbUser, String dbPasswordEnc, String dbType) {

    public static CmdbInstance fromRow(Map<String, Object> r) {
        String type = DbType.normalize(r.get("DB_TYPE"));
        Integer port = Values.toInt(r.get("PORT"));
        return new CmdbInstance(
                Values.toLong(r.get("INSTANCE_ID"), 0),
                Values.str(r.get("INSTANCE_NAME")),
                Values.str(r.get("HOST_IP"), ""),
                port == null || port <= 0 ? DbType.defaultPort(type) : port,
                Values.str(r.get("SID")),
                Values.str(r.get("SERVICE_NAME")),
                Values.str(r.get("DB_USER")),
                Values.raw(r.get("DB_PASSWORD")),
                type);
    }

    public String password() {
        return Secrets.decode(dbPasswordEnc);
    }

    /** MySQL/PG/SQLServer 的“库名”：优先 SERVICE_NAME，其次 SID（与 Node 一致） */
    public String databaseName(String def) {
        if (serviceName != null && !serviceName.isBlank()) {
            return serviceName.trim();
        }
        if (sid != null && !sid.isBlank()) {
            return sid.trim();
        }
        return def;
    }
}
