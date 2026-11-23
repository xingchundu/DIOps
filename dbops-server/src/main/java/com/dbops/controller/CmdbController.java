package com.dbops.controller;

import com.dbops.cmdb.CmdbExcelService;
import com.dbops.common.BizException;
import com.dbops.common.Db;
import com.dbops.common.R;
import com.dbops.common.Values;
import com.dbops.monitor.DbType;
import com.dbops.monitor.Secrets;
import com.dbops.security.CurrentUser;
import com.dbops.service.AuditService;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * /api/cmdb（同 Node routes/cmdb.js）
 */
@RestController
@RequestMapping("/api/cmdb")
public class CmdbController {

    static final String INSTANCE_LIST_COLUMNS = "INSTANCE_ID, INSTANCE_NAME, DB_TYPE, DB_VERSION, HOST_IP, PORT, SERVICE_NAME, SID, "
            + "DB_USER, CHARSET, STATUS, HEALTH_SCORE, ENVIRONMENT, BIZ_LINE, ROLE, CLUSTER_NAME, HOST_ID, TENANT_ID, CREATED_BY, "
            + "CREATED_AT, UPDATED_AT, LAST_CHECK, CASE WHEN DB_PASSWORD IS NOT NULL AND TRIM(DB_PASSWORD) IS NOT NULL THEN 1 ELSE 0 END AS HAS_DB_PASSWORD";
    static final String INSTANCE_JOIN_COLUMNS = "i.INSTANCE_ID, i.INSTANCE_NAME, i.DB_TYPE, i.DB_VERSION, i.HOST_IP, i.PORT, i.SERVICE_NAME, i.SID, "
            + "i.DB_USER, i.CHARSET, i.STATUS, i.HEALTH_SCORE, i.ENVIRONMENT, i.BIZ_LINE, i.ROLE, i.CLUSTER_NAME, i.HOST_ID, i.TENANT_ID, "
            + "i.CREATED_BY, i.CREATED_AT, i.UPDATED_AT, i.LAST_CHECK, "
            + "CASE WHEN i.DB_PASSWORD IS NOT NULL AND TRIM(i.DB_PASSWORD) IS NOT NULL THEN 1 ELSE 0 END AS HAS_DB_PASSWORD";
    private static final int[] PROBE_PORTS = {22, 1521, 3306, 5432, 1433, 5236, 3389, 80, 443};

    private final Db db;
    private final AuditService audit;
    private final CmdbExcelService excel;
    private final com.dbops.license.LicenseService license;
    private final ExecutorService probePool = Executors.newFixedThreadPool(16, r -> {
        Thread t = new Thread(r, "host-probe");
        t.setDaemon(true);
        return t;
    });

    public CmdbController(Db db, AuditService audit, CmdbExcelService excel, com.dbops.license.LicenseService license) {
        this.license = license;
        this.db = db;
        this.audit = audit;
        this.excel = excel;
    }

    // =========================== 实例 ===========================

    /** 授权的纳管实例上限；返回剩余可新增数，未限制返回 Integer.MAX_VALUE */
    private int instanceQuota() {
        Integer max = license.maxInstances();
        if (max == null) {
            return Integer.MAX_VALUE;
        }
        return (int) Math.max(0, max - db.count("SELECT COUNT(*) FROM CMDB_INSTANCE"));
    }

    @GetMapping("/instances")
    public Map<String, Object> instances(@RequestParam(required = false) String keyword,
                                         @RequestParam(required = false) String dbType,
                                         @RequestParam(required = false) String status,
                                         @RequestParam(required = false) String env,
                                         @RequestParam(required = false, defaultValue = "1") String page,
                                         @RequestParam(required = false, defaultValue = "20") String size) {
        List<String> where = new ArrayList<>(List.of("1=1"));
        List<Object> args = new ArrayList<>();
        if (!Values.isBlank(keyword)) {
            where.add("(INSTANCE_NAME LIKE ? OR HOST_IP LIKE ?)");
            args.add("%" + keyword.trim() + "%");
            args.add("%" + keyword.trim() + "%");
        }
        if (!Values.isBlank(dbType)) {
            where.add("DB_TYPE = ?");
            args.add(DbType.normalize(dbType));
        }
        if (!Values.isBlank(status)) {
            where.add("STATUS = ?");
            args.add(status.trim());
        }
        if (!Values.isBlank(env)) {
            where.add("ENVIRONMENT = ?");
            args.add(env.trim());
        }
        return R.ok(db.queryPage("SELECT " + INSTANCE_LIST_COLUMNS + " FROM CMDB_INSTANCE WHERE " + String.join(" AND ", where)
                + " ORDER BY CREATED_AT DESC", args, page, size));
    }

    @GetMapping("/instances/import-template")
    public ResponseEntity<byte[]> importTemplate() throws Exception {
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"cmdb_instance_import_template.xlsx\"")
                .contentType(MediaType.parseMediaType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))
                .body(excel.buildTemplate());
    }

    @PostMapping("/instances/bulk-import")
    public Map<String, Object> bulkImport(CurrentUser u, @RequestParam(value = "file", required = false) MultipartFile file) {
        u.require("ADMIN", "DBA");
        if (file == null || file.isEmpty()) {
            return R.badRequest("请上传 xlsx（字段名 file）");
        }
        String fn = file.getOriginalFilename() == null ? "" : file.getOriginalFilename();
        if (!fn.toLowerCase().endsWith(".xlsx")) {
            return R.badRequest("仅支持 .xlsx");
        }
        if (file.getSize() > 5L * 1024 * 1024) {
            return R.badRequest("文件不能超过 5MB");
        }
        List<Map<String, Object>> parsed;
        try {
            parsed = excel.parse(file.getInputStream());
        } catch (Exception e) {
            return R.fail(500, "解析 Excel 失败: " + e.getMessage());
        }
        int ok = 0;
        int quota = instanceQuota();
        List<Map<String, Object>> fail = new ArrayList<>();
        for (Map<String, Object> p : parsed) {
            if (!p.containsKey("_error") && ok >= quota) {
                fail.add(R.map("sheet", p.get("_sheet"), "line", p.get("_line"), "msg", "超出授权的纳管实例上限（" + license.maxInstances() + " 个）"));
                continue;
            }
            if (p.containsKey("_error")) {
                fail.add(R.map("sheet", p.get("_sheet"), "line", p.get("_line"), "msg", p.get("_error")));
                continue;
            }
            try {
                String type = Values.str(p.get("dbType"));
                int port = Values.toInt(p.get("port"), DbType.defaultPort(type));
                // [fix] Node 版批量导入不做重复检查，同一 Excel 导两次就出现两份实例（且都会被采集、重复告警）
                Map<String, Object> dup = findDuplicate(Values.str(p.get("hostIp")), port, type,
                        Values.str(p.get("sid")), Values.str(p.get("serviceName")), null);
                if (dup != null) {
                    fail.add(R.map("sheet", p.get("_sheet"), "line", p.get("_line"), "msg", "已存在相同连接标识的实例「" + dup.get("INSTANCE_NAME") + "」"));
                    continue;
                }
                db.update("INSERT INTO CMDB_INSTANCE (INSTANCE_NAME,DB_TYPE,DB_VERSION,HOST_IP,PORT,SID,SERVICE_NAME,DB_USER,DB_PASSWORD,CHARSET,"
                                + "STATUS,ENVIRONMENT,BIZ_LINE,TAGS,ROLE,CLUSTER_NAME,HOST_ID,CREATED_BY) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        p.get("instanceName"), type, p.get("dbVersion"), p.get("hostIp"), port, p.get("sid"), p.get("serviceName"),
                        p.get("dbUser"), Secrets.encode(Values.raw(p.get("dbPassword"))), p.get("charset"), DbType.initialStatus(type),
                        p.get("environment"), p.get("bizLine"), p.get("tags"), p.get("role"), null, null, u.userId());
                ok++;
            } catch (Exception e) {
                fail.add(R.map("sheet", p.get("_sheet"), "line", p.get("_line"), "msg", e.getMessage()));
            }
        }
        audit.log(u, "BULK_IMPORT_INSTANCE", "CMDB_INSTANCE", null, "SUCCESS", "ok=" + ok + ",fail=" + fail.size());
        return R.ok(R.map("ok", ok, "fail", fail), "导入完成：成功 " + ok + " 条，失败 " + fail.size() + " 条");
    }

    @GetMapping("/instances/{id}")
    public Map<String, Object> instance(@PathVariable("id") long id) {
        Map<String, Object> r = db.one("SELECT " + INSTANCE_JOIN_COLUMNS + ", h.HOSTNAME, h.OS_TYPE, h.CPU_CORES, h.MEMORY_GB, h.DATACENTER "
                + "FROM CMDB_INSTANCE i LEFT JOIN CMDB_HOST h ON i.HOST_ID = h.HOST_ID WHERE i.INSTANCE_ID = ?", id);
        return r == null ? R.notFound("实例不存在") : R.ok(r);
    }

    /** 连接唯一性指纹（与 findDuplicate 条件一致）：仅当编辑时变更连接信息才需做重复校验 */
    private static String connectionToken(String hostIp, int port, String dbType, String sid, String svc) {
        String t = DbType.normalize(dbType);
        int p = port > 0 ? port : DbType.defaultPort(t);
        String ident;
        if (sid != null) {
            ident = "SID:" + sid.trim().toUpperCase(Locale.ROOT);
        } else if (svc != null) {
            ident = "SVC:" + svc.trim().toUpperCase(Locale.ROOT);
        } else {
            ident = "NONE";
        }
        return (hostIp == null ? "" : hostIp.trim()) + "|" + p + "|" + t + "|" + ident;
    }

    private static String connectionTokenFromRow(Map<String, Object> row) {
        String type = DbType.normalize(Values.get(row, "DB_TYPE"));
        int port = Values.toInt(Values.get(row, "PORT"), DbType.defaultPort(type));
        return connectionToken(Values.str(Values.get(row, "HOST_IP")), port, type,
                Values.str(Values.get(row, "SID")), Values.str(Values.get(row, "SERVICE_NAME")));
    }

    private Map<String, Object> findDuplicate(String hostIp, int port, String dbType, String sid, String svc, Long excludeId) {
        StringBuilder sql = new StringBuilder("SELECT INSTANCE_ID, INSTANCE_NAME FROM CMDB_INSTANCE WHERE TRIM(HOST_IP)=? AND UPPER(DB_TYPE)=? AND NVL(PORT,?)=?");
        List<Object> args = new ArrayList<>(List.of(hostIp == null ? "" : hostIp.trim(), DbType.normalize(dbType), DbType.defaultPort(dbType), port));
        if (sid != null) {
            sql.append(" AND UPPER(TRIM(NVL(SID,'')))=UPPER(?)");
            args.add(sid.trim());
        } else if (svc != null) {
            sql.append(" AND UPPER(TRIM(NVL(SERVICE_NAME,'')))=UPPER(?)");
            args.add(svc.trim());
        } else {
            sql.append(" AND TRIM(NVL(SID,'')) IS NULL AND TRIM(NVL(SERVICE_NAME,'')) IS NULL");
        }
        if (excludeId != null) {
            sql.append(" AND INSTANCE_ID <> ?");
            args.add(excludeId);
        }
        List<Map<String, Object>> rows = db.query(sql.toString(), args);
        return rows.isEmpty() ? null : rows.get(0);
    }

    @PostMapping("/instances")
    public Map<String, Object> createInstance(CurrentUser u, @RequestBody(required = false) Map<String, Object> b) {
        u.require("ADMIN", "DBA");
        String name = Values.str(Values.get(b, "instanceName"));
        String type = DbType.normalize(Values.get(b, "dbType"));
        String host = Values.str(Values.get(b, "hostIp"));
        if (name == null || type.isEmpty() || host == null) {
            return R.badRequest("实例名称、数据库类型、主机IP不能为空");
        }
        if (instanceQuota() <= 0) {
            return R.fail(403, "已达到授权的纳管实例上限（" + license.maxInstances() + " 个），请联系供应商扩容");
        }
        // [fix] Node 版端口缺省一律 1521（MySQL/PG 实例不填端口时会连到 1521）；这里按类型取默认端口
        int port = Values.toInt(Values.get(b, "port"), DbType.defaultPort(type));
        String sid = Values.str(Values.get(b, "sid"));
        String svc = Values.str(Values.get(b, "serviceName"));
        Map<String, Object> dup = findDuplicate(host, port, type, sid, svc, null);
        if (dup != null) {
            return R.badRequest("已存在相同连接标识的实例「" + dup.get("INSTANCE_NAME") + "」（" + host + ":" + port + " / " + type + "），请勿重复添加");
        }
        Long id = db.insertReturningId("INSERT INTO CMDB_INSTANCE (INSTANCE_NAME,DB_TYPE,DB_VERSION,HOST_IP,PORT,SID,SERVICE_NAME,DB_USER,DB_PASSWORD,"
                        + "CHARSET,STATUS,ENVIRONMENT,BIZ_LINE,ROLE,CLUSTER_NAME,HOST_ID,CREATED_BY) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                "INSTANCE_ID", name, type, Values.str(Values.get(b, "dbVersion")), host, port, sid, svc, Values.str(Values.get(b, "dbUser")),
                Secrets.encode(Values.raw(Values.get(b, "dbPassword"))), Values.str(Values.get(b, "charset")), DbType.initialStatus(type),
                Values.str(Values.get(b, "environment"), "PROD"), Values.str(Values.get(b, "bizLine")), Values.str(Values.get(b, "role"), "PRIMARY"),
                Values.str(Values.get(b, "clusterName")), Values.toLong(Values.get(b, "hostId")), u.userId());
        audit.log(u, "CREATE_INSTANCE", "CMDB_INSTANCE", id == null ? null : String.valueOf(id), "SUCCESS", name);
        return R.msg("实例添加成功");
    }

    @PutMapping("/instances/{id}")
    public Map<String, Object> updateInstance(CurrentUser u, @PathVariable("id") long id, @RequestBody(required = false) Map<String, Object> b) {
        u.require("ADMIN", "DBA");
        String name = Values.str(Values.get(b, "instanceName"));
        String type = DbType.normalize(Values.get(b, "dbType"));
        String host = Values.str(Values.get(b, "hostIp"));
        if (name == null || type.isEmpty() || host == null) {
            return R.badRequest("实例名称、数据库类型、主机IP不能为空");
        }
        Map<String, Object> cur = db.one("SELECT HOST_IP, PORT, DB_TYPE, SID, SERVICE_NAME FROM CMDB_INSTANCE WHERE INSTANCE_ID=?", id);
        if (cur == null) {
            return R.notFound("实例不存在");
        }
        int port = Values.toInt(Values.get(b, "port"), DbType.defaultPort(type));
        String sid = Values.str(Values.get(b, "sid"));
        String svc = Values.str(Values.get(b, "serviceName"));
        String newTok = connectionToken(host, port, type, sid, svc);
        if (!newTok.equals(connectionTokenFromRow(cur))) {
            Map<String, Object> dup = findDuplicate(host, port, type, sid, svc, id);
            if (dup != null) {
                return R.badRequest("已存在相同连接标识的实例「" + dup.get("INSTANCE_NAME") + "」（" + host + ":" + port + " / " + type + "），请勿重复添加");
            }
        }
        String pwdEnc = Secrets.encode(Values.raw(Values.get(b, "dbPassword")));
        Long hostId = Values.toLong(Values.get(b, "hostId"));
        List<Object> args = new ArrayList<>(List.of());
        String set = "INSTANCE_NAME=?,DB_VERSION=?,PORT=?,CHARSET=?,ENVIRONMENT=?,BIZ_LINE=?,ROLE=?,HOST_IP=?,DB_TYPE=?,SID=?,SERVICE_NAME=?,DB_USER=?,HOST_ID=?";
        args.add(name);
        args.add(Values.str(Values.get(b, "dbVersion")));
        args.add(port);
        args.add(Values.str(Values.get(b, "charset")));
        args.add(Values.str(Values.get(b, "environment")));
        args.add(Values.str(Values.get(b, "bizLine")));
        args.add(Values.str(Values.get(b, "role")));
        args.add(host);
        args.add(type);
        args.add(sid);
        args.add(svc);
        args.add(Values.str(Values.get(b, "dbUser")));
        args.add(hostId);
        if (pwdEnc != null) {
            set += ",DB_PASSWORD=?";
            args.add(pwdEnc);
        }
        args.add(id);
        db.update("UPDATE CMDB_INSTANCE SET " + set + ", UPDATED_AT=SYSTIMESTAMP WHERE INSTANCE_ID=?", args);
        audit.log(u, "UPDATE_INSTANCE", "CMDB_INSTANCE", String.valueOf(id), "SUCCESS", name);
        return R.msg("更新成功");
    }

    private static final int SQL_INSIGHT_DELETE_BATCH = 4000;
    private static final int DELETE_DEADLOCK_RETRIES = 12;

    private static final List<String> SQL_INSIGHT_PURGE = List.of(
            "DELETE FROM DI_SQL_ANOMALY_DIAGNOSIS WHERE ANOMALY_ID IN (SELECT ANOMALY_ID FROM DI_SQL_ANOMALY WHERE INSTANCE_ID=?)",
            "DELETE FROM DI_SQL_ANOMALY WHERE INSTANCE_ID=?", "DELETE FROM DI_SQL_PROBLEM WHERE INSTANCE_ID=?",
            "DELETE FROM DI_SQL_BASELINE WHERE INSTANCE_ID=?", "DELETE FROM DI_SQL_BASELINE_ANCHOR WHERE INSTANCE_ID=?",
            "DELETE FROM DI_SQL_ASSET_SOURCE WHERE INSTANCE_ID=?", "DELETE FROM DI_SQL_CAPABILITY WHERE INSTANCE_ID=?",
            "DELETE FROM DI_CHANGE_WINDOW WHERE INSTANCE_ID=?");

    private static final String SQL_INSIGHT_STATS_MIN_BATCH =
            "DELETE FROM DI_SQL_STATS_MIN WHERE INSTANCE_ID=? AND ROWNUM <= " + SQL_INSIGHT_DELETE_BATCH;

    /** 与后台 SQL 洞察采集错峰：大表分批、短事务提交，避免单事务 DELETE 与 MERGE 互锁 ORA-00060 */
    private void purgeSqlInsightForInstance(long id) {
        for (String sql : SQL_INSIGHT_PURGE) {
            runInstanceDelete(sql, id);
        }
        purgeStatsMinBatched(id);
    }

    private void purgeStatsMinBatched(long id) {
        int n;
        do {
            n = runInstanceDelete(SQL_INSIGHT_STATS_MIN_BATCH, id);
        } while (n > 0);
    }

    private int runInstanceDelete(String sql, long id) {
        for (int attempt = 0; attempt < DELETE_DEADLOCK_RETRIES; attempt++) {
            try {
                return db.update(sql, id);
            } catch (Exception e) {
                if (Db.isMissingTable(e)) {
                    return 0;
                }
                if (Db.isDeadlock(e) && attempt < DELETE_DEADLOCK_RETRIES - 1) {
                    deadlockBackoff(attempt);
                    continue;
                }
                throw e;
            }
        }
        throw new BizException(500, "删除实例关联数据时数据库繁忙（与采集任务冲突），请稍后重试");
    }

    private static void deadlockBackoff(int attempt) {
        try {
            Thread.sleep(150L * (attempt + 1));
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
            throw new BizException(500, "删除已中断");
        }
    }

    private void deleteInstanceRow(long id) {
        for (int attempt = 0; attempt < DELETE_DEADLOCK_RETRIES; attempt++) {
            try {
                db.inTx(() -> {
                    db.update("DELETE FROM CMDB_CLUSTER_MEMBER WHERE INSTANCE_ID=?", id);
                    try {
                        db.update("DELETE FROM CMDB_APP_DB_RELATION WHERE INSTANCE_ID=?", id);
                    } catch (Exception e) {
                        if (!Db.isMissingTable(e)) {
                            throw e;
                        }
                    }
                    db.update("DELETE FROM CMDB_INSTANCE WHERE INSTANCE_ID=?", id);
                });
                return;
            } catch (Exception e) {
                if (Db.isDeadlock(e) && attempt < DELETE_DEADLOCK_RETRIES - 1) {
                    deadlockBackoff(attempt);
                    continue;
                }
                throw e;
            }
        }
        throw new BizException(500, "删除实例失败：数据库繁忙，请稍后重试");
    }

    @DeleteMapping("/instances/{id}")
    public Map<String, Object> deleteInstance(CurrentUser u, @PathVariable("id") long id) {
        if (!u.hasRole("ADMIN", "DBA")) {
            return R.forbidden();
        }
        Map<String, Object> r = db.one("SELECT INSTANCE_NAME FROM CMDB_INSTANCE WHERE INSTANCE_ID=?", id);
        if (r == null) {
            return R.notFound("实例不存在");
        }
        // SQL 洞察表无 FK，但 DELETE 量大；在短事务外先清，再删 CMDB 主记录（仍须处理集群/应用关系外键）
        purgeSqlInsightForInstance(id);
        deleteInstanceRow(id);
        audit.log(u, "DELETE_INSTANCE", "CMDB_INSTANCE", String.valueOf(id), "SUCCESS", String.valueOf(r.get("INSTANCE_NAME")));
        return R.msg("删除成功");
    }

    // =========================== 主机 ===========================

    static Map<String, Object> sanitizeHost(Map<String, Object> row) {
        Map<String, Object> o = new LinkedHashMap<>(row);
        Object pwd = o.remove("SSH_PASSWORD");
        Object key = o.remove("SSH_PRIVATE_KEY");
        o.put("HAS_SSH_PASSWORD", Values.isBlank(pwd) ? 0 : 1);
        o.put("HAS_SSH_PRIVATE_KEY", Values.isBlank(key) ? 0 : 1);
        return o;
    }

    @GetMapping("/hosts")
    public Map<String, Object> hosts(@RequestParam(required = false) String keyword,
                                     @RequestParam(required = false) String status,
                                     @RequestParam(required = false) String datacenter) {
        List<String> where = new ArrayList<>(List.of("1=1"));
        List<Object> args = new ArrayList<>();
        if (!Values.isBlank(keyword)) {
            String k = "%" + keyword.trim().toUpperCase() + "%";
            where.add("(UPPER(HOSTNAME) LIKE ? OR UPPER(IP_ADDR) LIKE ?)");
            args.add(k);
            args.add(k);
        }
        if (!Values.isBlank(status)) {
            where.add("STATUS=?");
            args.add(status.trim());
        }
        if (!Values.isBlank(datacenter)) {
            where.add("DATACENTER=?");
            args.add(datacenter.trim());
        }
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map<String, Object> r : db.query("SELECT * FROM CMDB_HOST WHERE " + String.join(" AND ", where) + " ORDER BY HOST_ID", args)) {
            out.add(sanitizeHost(r));
        }
        return R.ok(out);
    }

    @PostMapping("/hosts")
    public Map<String, Object> createHost(CurrentUser u, @RequestBody(required = false) Map<String, Object> b) {
        if (!u.hasRole("ADMIN", "DBA")) {
            return R.forbidden();
        }
        String hostname = Values.str(Values.get(b, "hostname"));
        String ip = Values.str(Values.get(b, "ipAddr"));
        if (hostname == null || ip == null) {
            return R.badRequest("主机名和IP地址不能为空");
        }
        if (db.count("SELECT COUNT(*) FROM CMDB_HOST WHERE IP_ADDR=?", ip) > 0) {
            return R.fail(409, "该IP地址已存在");
        }
        db.update("INSERT INTO CMDB_HOST(HOSTNAME,IP_ADDR,OS_TYPE,OS_VERSION,CPU_CORES,MEMORY_GB,DATACENTER,STATUS,SSH_ENABLED,SSH_PORT,SSH_USER,"
                        + "SSH_AUTH_TYPE,SSH_PASSWORD,SSH_PRIVATE_KEY) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                hostname, ip, Values.str(Values.get(b, "osType")), Values.str(Values.get(b, "osVersion")), Values.toDouble(Values.get(b, "cpuCores")),
                Values.toDouble(Values.get(b, "memoryGb")), Values.str(Values.get(b, "datacenter")), Values.str(Values.get(b, "status"), "ONLINE"),
                Values.truthy(Values.get(b, "sshEnabled")) ? 1 : 0, Values.toInt(Values.get(b, "sshPort"), 22), Values.str(Values.get(b, "sshUser")),
                Values.str(Values.get(b, "sshAuthType"), "PASSWORD"), Secrets.encode(Values.raw(Values.get(b, "sshPassword"))),
                Secrets.encode(Values.raw(Values.get(b, "sshPrivateKey"))));
        audit.log(u, "CREATE_HOST", hostname + "(" + ip + ")", null, "SUCCESS", null);
        return R.msg("主机创建成功");
    }

    @PutMapping("/hosts/{id}")
    public Map<String, Object> updateHost(CurrentUser u, @PathVariable("id") long id, @RequestBody(required = false) Map<String, Object> b) {
        if (!u.hasRole("ADMIN", "DBA")) {
            return R.forbidden();
        }
        Map<String, Object> old = db.one("SELECT HOSTNAME, IP_ADDR FROM CMDB_HOST WHERE HOST_ID=?", id);
        if (old == null) {
            return R.notFound("主机不存在");
        }
        String ip = Values.str(Values.get(b, "ipAddr"));
        String hostname = Values.str(Values.get(b, "hostname"));
        if (hostname == null || ip == null) {
            return R.badRequest("主机名和IP地址不能为空");
        }
        // [fix] Node 版更新时不查 IP 重复，可把两台主机改成同一个 IP
        if (db.count("SELECT COUNT(*) FROM CMDB_HOST WHERE IP_ADDR=? AND HOST_ID<>?", ip, id) > 0) {
            return R.fail(409, "该IP地址已存在");
        }
        String pwdEnc = Secrets.encode(Values.raw(Values.get(b, "sshPassword")));
        String keyEnc = Secrets.encode(Values.raw(Values.get(b, "sshPrivateKey")));
        db.update("UPDATE CMDB_HOST SET HOSTNAME=?,IP_ADDR=?,OS_TYPE=?,OS_VERSION=?,CPU_CORES=?,MEMORY_GB=?,DATACENTER=?,STATUS=?,SSH_ENABLED=?,"
                        + "SSH_PORT=?,SSH_USER=?,SSH_AUTH_TYPE=?,SSH_PASSWORD=NVL(?, SSH_PASSWORD),SSH_PRIVATE_KEY=NVL(?, SSH_PRIVATE_KEY) WHERE HOST_ID=?",
                hostname, ip, Values.str(Values.get(b, "osType")), Values.str(Values.get(b, "osVersion")), Values.toDouble(Values.get(b, "cpuCores")),
                Values.toDouble(Values.get(b, "memoryGb")), Values.str(Values.get(b, "datacenter")), Values.str(Values.get(b, "status"), "ONLINE"),
                Values.truthy(Values.get(b, "sshEnabled")) ? 1 : 0, Values.toInt(Values.get(b, "sshPort"), 22), Values.str(Values.get(b, "sshUser")),
                Values.str(Values.get(b, "sshAuthType"), "PASSWORD"), pwdEnc, keyEnc, id);
        audit.log(u, "UPDATE_HOST", String.valueOf(old.get("HOSTNAME")), String.valueOf(id), "SUCCESS", null);
        return R.msg("主机更新成功");
    }

    @DeleteMapping("/hosts/{id}")
    public Map<String, Object> deleteHost(CurrentUser u, @PathVariable("id") long id) {
        if (!u.hasRole("ADMIN", "DBA")) {
            return R.forbidden();
        }
        Map<String, Object> old = db.one("SELECT HOSTNAME FROM CMDB_HOST WHERE HOST_ID=?", id);
        if (old == null) {
            return R.notFound("主机不存在");
        }
        if (db.count("SELECT COUNT(*) AS C FROM CMDB_INSTANCE WHERE HOST_ID=?", id) > 0) {
            return R.fail(409, "该主机下仍有数据库实例，请先迁移实例后再删除");
        }
        db.update("DELETE FROM CMDB_HOST WHERE HOST_ID=?", id);
        audit.log(u, "DELETE_HOST", String.valueOf(old.get("HOSTNAME")), String.valueOf(id), "SUCCESS", null);
        return R.msg("主机删除成功");
    }

    /**
     * TCP 探测常用端口，任一可连即可达。
     * [fix] Node 版首个端口连通后其余 socket 未销毁（连接泄漏），且探测端口不含 SQL Server 1433 / 达梦 5236。
     */
    Map<String, Object> probe(String ip, int timeoutMs) {
        long start = System.currentTimeMillis();
        List<CompletableFuture<Integer>> fs = new ArrayList<>();
        for (int port : PROBE_PORTS) {
            fs.add(CompletableFuture.supplyAsync(() -> {
                try (Socket s = new Socket()) {
                    s.connect(new InetSocketAddress(ip, port), timeoutMs);
                    return port;
                } catch (Exception e) {
                    return null;
                }
            }, probePool));
        }
        Integer hit = null;
        long deadline = start + timeoutMs + 200;
        for (CompletableFuture<Integer> f : fs) {
            try {
                Integer p = f.get(Math.max(1, deadline - System.currentTimeMillis()), TimeUnit.MILLISECONDS);
                if (p != null) {
                    hit = p;
                    break;
                }
            } catch (Exception ignore) {
                // timeout
            }
        }
        // 已命中或已超时：取消剩余探测，避免它们继续占着探测线程池（批量检查时后面的主机排队）
        for (CompletableFuture<Integer> f : fs) {
            f.cancel(true);
        }
        return R.map("reachable", hit != null, "port", hit, "latencyMs", System.currentTimeMillis() - start);
    }

    @PostMapping("/hosts/{id}/check")
    public Map<String, Object> checkHost(CurrentUser u, @PathVariable("id") long id) {
        // 会对任意登记 IP 做端口探测并改主机状态：只读角色不可调用，并记审计
        u.require("ADMIN", "DBA", "OPS");
        Map<String, Object> h = db.one("SELECT HOST_ID, IP_ADDR, STATUS FROM CMDB_HOST WHERE HOST_ID=?", id);
        if (h == null) {
            return R.notFound("主机不存在");
        }
        String ip = Values.str(h.get("IP_ADDR"));
        if (ip == null) {
            return R.badRequest("主机IP地址为空");
        }
        Map<String, Object> res = probe(ip, 3000);
        boolean reachable = Boolean.TRUE.equals(res.get("reachable"));
        String newStatus = reachable ? "ONLINE" : "OFFLINE";
        String oldStatus = Values.str(h.get("STATUS"));
        if (!newStatus.equals(oldStatus) && !"MAINTENANCE".equals(oldStatus)) {
            db.update("UPDATE CMDB_HOST SET STATUS=? WHERE HOST_ID=?", newStatus, id);
        }
        audit.log(u, "CHECK_HOST", "CMDB_HOST", String.valueOf(id), "SUCCESS", ip + " -> " + newStatus);
        return R.ok(R.map("hostId", h.get("HOST_ID"), "ip", ip, "reachable", reachable, "port", res.get("port"),
                "latencyMs", res.get("latencyMs"), "oldStatus", oldStatus,
                "newStatus", "MAINTENANCE".equals(oldStatus) ? "MAINTENANCE" : newStatus));
    }

    @PostMapping("/hosts/check-all")
    public Map<String, Object> checkAllHosts(CurrentUser u) {
        u.require("ADMIN", "DBA", "OPS");
        List<Map<String, Object>> hosts = db.query("SELECT HOST_ID, IP_ADDR, STATUS FROM CMDB_HOST WHERE IP_ADDR IS NOT NULL");
        List<CompletableFuture<Map<String, Object>>> fs = new ArrayList<>();
        ExecutorService pool = Executors.newFixedThreadPool(Math.max(1, Math.min(8, hosts.size())));
        try {
            for (Map<String, Object> h : hosts) {
                fs.add(CompletableFuture.supplyAsync(() -> {
                    String ip = Values.str(h.get("IP_ADDR"), "");
                    Map<String, Object> res = probe(ip, 3000);
                    boolean reachable = Boolean.TRUE.equals(res.get("reachable"));
                    return R.map("hostId", h.get("HOST_ID"), "ip", ip, "reachable", reachable, "port", res.get("port"),
                            "latencyMs", res.get("latencyMs"), "oldStatus", h.get("STATUS"), "newStatus", reachable ? "ONLINE" : "OFFLINE");
                }, pool));
            }
            List<Map<String, Object>> results = new ArrayList<>();
            int updated = 0;
            for (CompletableFuture<Map<String, Object>> f : fs) {
                Map<String, Object> r = f.join();
                results.add(r);
                String oldS = Values.str(r.get("oldStatus"));
                String newS = Values.str(r.get("newStatus"));
                if (!newS.equals(oldS) && !"MAINTENANCE".equals(oldS)) {
                    updated += db.update("UPDATE CMDB_HOST SET STATUS=? WHERE HOST_ID=?", newS, r.get("hostId"));
                }
            }
            audit.log(u, "CHECK_ALL_HOSTS", "CMDB_HOST", null, "SUCCESS", "hosts=" + results.size() + ",updated=" + updated);
            return R.ok(R.map("results", results, "updated", updated));
        } finally {
            pool.shutdown();
        }
    }

    // =========================== 集群 ===========================

    @GetMapping("/clusters")
    public Map<String, Object> clusters() {
        return R.ok(db.query("SELECT c.*, (SELECT COUNT(*) FROM CMDB_CLUSTER_MEMBER m WHERE m.CLUSTER_ID=c.CLUSTER_ID) AS MEMBER_COUNT "
                + "FROM CMDB_CLUSTER c ORDER BY c.CLUSTER_ID"));
    }

    @GetMapping("/clusters/{id}")
    public Map<String, Object> cluster(@PathVariable("id") long id) {
        Map<String, Object> c = db.one("SELECT * FROM CMDB_CLUSTER WHERE CLUSTER_ID=?", id);
        if (c == null) {
            return R.notFound("集群不存在");
        }
        Map<String, Object> out = new LinkedHashMap<>(c);
        out.put("members", db.query("SELECT m.MEMBER_ID, m.NODE_ROLE, m.SORT_ORDER, i.INSTANCE_ID, i.INSTANCE_NAME, i.DB_TYPE, i.HOST_IP, i.PORT, "
                + "i.STATUS, i.HEALTH_SCORE FROM CMDB_CLUSTER_MEMBER m JOIN CMDB_INSTANCE i ON m.INSTANCE_ID = i.INSTANCE_ID "
                + "WHERE m.CLUSTER_ID = ? ORDER BY m.SORT_ORDER, m.MEMBER_ID", id));
        return R.ok(out);
    }

    @PostMapping("/clusters")
    public Map<String, Object> createCluster(CurrentUser u, @RequestBody(required = false) Map<String, Object> b) {
        if (!u.hasRole("ADMIN", "DBA")) {
            return R.forbidden();
        }
        String name = Values.str(Values.get(b, "clusterName"));
        String type = Values.str(Values.get(b, "clusterType"));
        if (name == null || type == null) {
            return R.badRequest("集群名称和类型不能为空");
        }
        Long expected = Values.toLong(Values.get(b, "expectedMemberCount"));
        try {
            db.update("INSERT INTO CMDB_CLUSTER(CLUSTER_NAME,CLUSTER_TYPE,DESCRIPTION,VIP,STATUS,EXPECTED_MEMBER_COUNT) VALUES(?,?,?,?,?,?)",
                    name, type, Values.str(Values.get(b, "description")), Values.str(Values.get(b, "vip")),
                    Values.str(Values.get(b, "status"), "NORMAL"), expected);
        } catch (Exception e) {
            if (!Db.isMissingColumn(e)) {
                throw e;
            }
            db.update("INSERT INTO CMDB_CLUSTER(CLUSTER_NAME,CLUSTER_TYPE,DESCRIPTION,VIP,STATUS) VALUES(?,?,?,?,?)",
                    name, type, Values.str(Values.get(b, "description")), Values.str(Values.get(b, "vip")), Values.str(Values.get(b, "status"), "NORMAL"));
        }
        audit.log(u, "CREATE_CLUSTER", name, null, "SUCCESS", null);
        return R.msg("集群创建成功");
    }

    @PutMapping("/clusters/{id}")
    public Map<String, Object> updateCluster(CurrentUser u, @PathVariable("id") long id, @RequestBody(required = false) Map<String, Object> b) {
        if (!u.hasRole("ADMIN", "DBA")) {
            return R.forbidden();
        }
        Map<String, Object> old = db.one("SELECT CLUSTER_NAME, CLUSTER_TYPE, STATUS FROM CMDB_CLUSTER WHERE CLUSTER_ID=?", id);
        if (old == null) {
            return R.notFound("集群不存在");
        }
        // [fix] Node 版未传的字段会被更新成 NULL（CLUSTER_NAME/CLUSTER_TYPE 为 NOT NULL 时直接报错）
        String name = Values.str(Values.get(b, "clusterName"), Values.str(old.get("CLUSTER_NAME")));
        String type = Values.str(Values.get(b, "clusterType"), Values.str(old.get("CLUSTER_TYPE")));
        String status = Values.str(Values.get(b, "status"), Values.str(old.get("STATUS")));
        db.update("UPDATE CMDB_CLUSTER SET CLUSTER_NAME=?,CLUSTER_TYPE=?,DESCRIPTION=?,VIP=?,STATUS=?,UPDATED_AT=SYSTIMESTAMP WHERE CLUSTER_ID=?",
                name, type, Values.str(Values.get(b, "description")), Values.str(Values.get(b, "vip")), status, id);
        if (b != null && b.containsKey("expectedMemberCount")) {
            db.updateQuietly("UPDATE CMDB_CLUSTER SET EXPECTED_MEMBER_COUNT=? WHERE CLUSTER_ID=?", Values.toLong(b.get("expectedMemberCount")), id);
        }
        audit.log(u, "UPDATE_CLUSTER", String.valueOf(old.get("CLUSTER_NAME")), String.valueOf(id), "SUCCESS", null);
        return R.msg("集群更新成功");
    }

    @DeleteMapping("/clusters/{id}")
    public Map<String, Object> deleteCluster(CurrentUser u, @PathVariable("id") long id) {
        if (!u.hasRole("ADMIN", "DBA")) {
            return R.forbidden();
        }
        Map<String, Object> old = db.one("SELECT CLUSTER_NAME FROM CMDB_CLUSTER WHERE CLUSTER_ID=?", id);
        if (old == null) {
            return R.notFound("集群不存在");
        }
        db.inTx(() -> {
            db.update("DELETE FROM CMDB_CLUSTER_MEMBER WHERE CLUSTER_ID=?", id);
            db.update("DELETE FROM CMDB_CLUSTER WHERE CLUSTER_ID=?", id);
        });
        audit.log(u, "DELETE_CLUSTER", String.valueOf(old.get("CLUSTER_NAME")), String.valueOf(id), "SUCCESS", null);
        return R.msg("集群已删除");
    }

    @PostMapping("/clusters/{id}/members")
    public Map<String, Object> addMember(CurrentUser u, @PathVariable("id") long id, @RequestBody(required = false) Map<String, Object> b) {
        if (!u.hasRole("ADMIN", "DBA")) {
            return R.forbidden();
        }
        Long instanceId = Values.toLong(Values.get(b, "instanceId"));
        if (instanceId == null) {
            return R.badRequest("实例ID不能为空");
        }
        if (db.one("SELECT CLUSTER_NAME FROM CMDB_CLUSTER WHERE CLUSTER_ID=?", id) == null) {
            return R.notFound("集群不存在");
        }
        if (db.one("SELECT INSTANCE_ID FROM CMDB_INSTANCE WHERE INSTANCE_ID=?", instanceId) == null) {
            return R.notFound("实例不存在");
        }
        if (db.count("SELECT COUNT(*) FROM CMDB_CLUSTER_MEMBER WHERE CLUSTER_ID=? AND INSTANCE_ID=?", id, instanceId) > 0) {
            return R.fail(409, "该实例已在集群中");
        }
        db.update("INSERT INTO CMDB_CLUSTER_MEMBER(CLUSTER_ID,INSTANCE_ID,NODE_ROLE) VALUES(?,?,?)", id, instanceId,
                Values.str(Values.get(b, "nodeRole"), "PRIMARY"));
        return R.msg("成员添加成功");
    }

    @DeleteMapping("/clusters/{id}/members/{instanceId}")
    public Map<String, Object> removeMember(CurrentUser u, @PathVariable("id") long id, @PathVariable("instanceId") long instanceId) {
        if (!u.hasRole("ADMIN", "DBA")) {
            return R.forbidden();
        }
        db.update("DELETE FROM CMDB_CLUSTER_MEMBER WHERE CLUSTER_ID=? AND INSTANCE_ID=?", id, instanceId);
        return R.msg("成员已移除");
    }

    @GetMapping("/stats")
    public Map<String, Object> stats() {
        Map<String, Object> r = db.one("SELECT COUNT(*) AS TOTAL, SUM(CASE WHEN STATUS='RUNNING' THEN 1 ELSE 0 END) AS RUNNING, "
                + "SUM(CASE WHEN STATUS='ERROR' THEN 1 ELSE 0 END) AS ERR FROM CMDB_INSTANCE");
        return R.ok(R.map("total", r.get("TOTAL"), "running", Values.toLong(r.get("RUNNING"), 0), "error", Values.toLong(r.get("ERR"), 0),
                "byType", db.query("SELECT DB_TYPE, COUNT(*) AS CNT FROM CMDB_INSTANCE GROUP BY DB_TYPE")));
    }
}
