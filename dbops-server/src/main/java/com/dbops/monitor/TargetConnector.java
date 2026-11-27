package com.dbops.monitor;

import com.dbops.common.BizException;
import com.dbops.common.Db;
import com.dbops.config.DbopsProperties;
import org.springframework.stereotype.Component;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.util.Map;
import java.util.Properties;

/**
 * 按 CMDB 实例类型建立被管库 JDBC 连接（对应 Node monitorTargetConn.js 的 connectXxx）。
 * <p>
 * [fix] Node 版 Oracle 只填了 SID 时用 host:port/SID（EZConnect 把它当服务名），SID 与服务名不同的库会报 ORA-12514；
 * 这里只有 SID 时先按 SID 语法 host:port:SID 连接，ORA-12505 时再回退成服务名写法，兼容两种填法。
 */
@Component
public class TargetConnector {

    static {
        for (String drv : new String[]{"oracle.jdbc.OracleDriver", "com.mysql.cj.jdbc.Driver", "org.postgresql.Driver",
                "com.microsoft.sqlserver.jdbc.SQLServerDriver", "dm.jdbc.driver.DmDriver"}) {
            try {
                Class.forName(drv);
            } catch (Throwable ignore) {
                // 驱动缺失时对应类型连接会报错，其余类型不受影响
            }
        }
    }

    private final Db db;
    private final DbopsProperties.Monitor cfg;

    public TargetConnector(Db db, DbopsProperties props) {
        this.db = db;
        this.cfg = props.getMonitor();
    }

    public CmdbInstance fetch(long instanceId) {
        Map<String, Object> r = db.one("SELECT INSTANCE_ID, INSTANCE_NAME, HOST_IP, PORT, SID, SERVICE_NAME, DB_USER, DB_PASSWORD, DB_TYPE "
                + "FROM CMDB_INSTANCE WHERE INSTANCE_ID=?", instanceId);
        if (r == null) {
            throw BizException.notFound("实例不存在");
        }
        return CmdbInstance.fromRow(r);
    }

    public TargetDb open(CmdbInstance inst) throws SQLException {
        String t = inst.dbType();
        int connectSec = Math.max(3, cfg.getTargetConnectTimeoutSec());
        int querySec = Math.max(5, cfg.getTargetQueryTimeoutSec());
        String host = inst.hostIp().trim();
        if (host.isEmpty()) {
            throw new SQLException("实例未配置主机IP");
        }
        Properties p = new Properties();
        if (inst.dbUser() != null) {
            p.setProperty("user", inst.dbUser());
        }
        p.setProperty("password", inst.password());
        Connection c;
        switch (t) {
            case DbType.ORACLE -> {
                p.setProperty("oracle.net.CONNECT_TIMEOUT", String.valueOf(connectSec * 1000));
                p.setProperty("oracle.jdbc.J2EE13Compliant", "true");
                p.setProperty("v$session.program", "DIOps-Monitor");
                c = openOracle(inst, host, p);
            }
            case DbType.DAMENG -> {
                p.setProperty("connectTimeout", String.valueOf(connectSec * 1000));
                p.setProperty("appName", "DIOps-Monitor");
                c = DriverManager.getConnection("jdbc:dm://" + host + ":" + inst.port(), p);
            }
            case DbType.MYSQL, DbType.GOLDENDB -> {
                p.setProperty("connectTimeout", String.valueOf(connectSec * 1000));
                p.setProperty("socketTimeout", String.valueOf((querySec + 10) * 1000));
                // 原来强制 useSSL=false。改为 PREFERRED：服务端支持 TLS 就加密，不支持时退回明文（兼容老库）；
                // 要求必须加密可设 DBOPS_MYSQL_SSL_MODE=REQUIRED / VERIFY_CA
                // .env 由 EnvFileLoader 写入系统属性，不进进程环境变量
                String sslMode = System.getenv("DBOPS_MYSQL_SSL_MODE");
                if (sslMode == null || sslMode.isBlank()) {
                    sslMode = System.getProperty("DBOPS_MYSQL_SSL_MODE");
                }
                if (sslMode == null || sslMode.isBlank()) {
                    sslMode = "PREFERRED";
                }
                p.setProperty("sslMode", sslMode);
                p.setProperty("allowPublicKeyRetrieval", "true");
                p.setProperty("characterEncoding", "UTF-8");
                p.setProperty("serverTimezone", "UTC");
                String dbName = inst.databaseName("");
                c = DriverManager.getConnection("jdbc:mysql://" + host + ":" + inst.port() + "/" + dbName, p);
            }
            case DbType.POSTGRESQL, DbType.PANWEI -> {
                p.setProperty("connectTimeout", String.valueOf(connectSec));
                p.setProperty("socketTimeout", String.valueOf(querySec + 10));
                p.setProperty("ApplicationName", "DIOps-Monitor");
                String dbName = inst.databaseName("postgres");
                c = DriverManager.getConnection("jdbc:postgresql://" + host + ":" + inst.port() + "/" + dbName, p);
            }
            case DbType.SQLSERVER -> {
                String dbName = inst.databaseName("master");
                String url = "jdbc:sqlserver://" + host + ":" + inst.port()
                        + ";databaseName=" + dbName
                        + ";encrypt=" + cfg.isMssqlEncrypt()
                        + ";trustServerCertificate=" + cfg.isMssqlTrustCert()
                        + ";loginTimeout=" + connectSec
                        + ";applicationName=DIOps-Monitor";
                c = DriverManager.getConnection(url, p);
            }
            default -> throw new SQLException("监控采集不支持类型「" + t
                    + "」，请使用 CMDB 中的 ORACLE / MYSQL / POSTGRESQL / DAMENG / GOLDENDB / PANWEI / SQLSERVER");
        }
        try {
            c.setReadOnly(false);
        } catch (SQLException ignore) {
            // some drivers don't support it
        }
        return new TargetDb(c, t, querySec);
    }

    private Connection openOracle(CmdbInstance inst, String host, Properties p) throws SQLException {
        String svc = inst.serviceName();
        if (svc != null && !svc.isBlank()) {
            return DriverManager.getConnection("jdbc:oracle:thin:@//" + host + ":" + inst.port() + "/" + svc.trim(), p);
        }
        String sid = inst.sid() == null ? "" : inst.sid().trim();
        if (sid.isEmpty()) {
            throw new SQLException("Oracle 实例需配置 SERVICE_NAME 或 SID");
        }
        try {
            return DriverManager.getConnection("jdbc:oracle:thin:@" + host + ":" + inst.port() + ":" + sid, p);
        } catch (SQLException e) {
            if (e.getErrorCode() == 12505 || String.valueOf(e.getMessage()).contains("ORA-12505")) {
                return DriverManager.getConnection("jdbc:oracle:thin:@//" + host + ":" + inst.port() + "/" + sid, p);
            }
            throw e;
        }
    }

    public TargetDb open(long instanceId) throws SQLException {
        return open(fetch(instanceId));
    }
}
