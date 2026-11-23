package com.dbops.config;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

/**
 * 平台库（Oracle）连接池。连接串规则与 Node 版一致：
 * DB_CONNECT_STRING 优先；否则 host:port/serviceName，未配 serviceName 时按 Node 习惯把 SID 当作 EZConnect 服务名。
 */
@Configuration
public class DataSourceConfig {

    private static final Logger log = LoggerFactory.getLogger(DataSourceConfig.class);

    @Bean(destroyMethod = "close")
    public HikariDataSource dataSource(DbopsProperties props) {
        DbopsProperties.Datasource ds = props.getDatasource();
        String url = buildJdbcUrl(ds);
        HikariConfig cfg = new HikariConfig();
        cfg.setPoolName("dbops-oracle");
        cfg.setDriverClassName("oracle.jdbc.OracleDriver");
        cfg.setJdbcUrl(url);
        cfg.setUsername(ds.getUsername());
        cfg.setPassword(ds.getPassword());
        cfg.setMinimumIdle(Math.max(1, ds.getPoolMin()));
        cfg.setMaximumPoolSize(Math.max(2, ds.getPoolMax()));
        cfg.setConnectionTimeout(10_000);
        cfg.setIdleTimeout(60_000);
        cfg.setMaxLifetime(30 * 60_000L);
        cfg.setAutoCommit(true);
        // 平台库暂时不可达时仍可启动，后续请求/采集会在连接恢复后自动成功（Node 版是直接退出进程）
        cfg.setInitializationFailTimeout(-1);
        cfg.addDataSourceProperty("oracle.jdbc.J2EE13Compliant", "true");
        cfg.addDataSourceProperty("oracle.net.CONNECT_TIMEOUT", "10000");
        log.info("[DB] Oracle pool -> {} (min={}, max={})", url, cfg.getMinimumIdle(), cfg.getMaximumPoolSize());
        return new HikariDataSource(cfg);
    }

    @Bean
    public JdbcTemplate jdbcTemplate(DataSource dataSource) {
        JdbcTemplate t = new JdbcTemplate(dataSource);
        t.setQueryTimeout(120);
        return t;
    }

    @Bean
    public DataSourceTransactionManager transactionManager(DataSource dataSource) {
        return new DataSourceTransactionManager(dataSource);
    }

    @Bean
    public TransactionTemplate transactionTemplate(DataSourceTransactionManager tm) {
        return new TransactionTemplate(tm);
    }

    static String buildJdbcUrl(DbopsProperties.Datasource ds) {
        String cs = trim(ds.getConnectString());
        if (!cs.isEmpty()) {
            if (cs.startsWith("jdbc:")) {
                return cs;
            }
            // EZConnect（host:port/svc）或 TNS 描述串
            return cs.startsWith("(") ? "jdbc:oracle:thin:@" + cs : "jdbc:oracle:thin:@//" + cs.replaceFirst("^//", "");
        }
        String host = trim(ds.getHost());
        String svc = trim(ds.getServiceName());
        String sid = trim(ds.getSid());
        if (host.isEmpty() || (svc.isEmpty() && sid.isEmpty())) {
            throw new IllegalStateException("DB_CONNECT_STRING 或 (DB_HOST 与 DB_SERVICE_NAME/DB_SID) 必须配置");
        }
        return "jdbc:oracle:thin:@//" + host + ":" + ds.getPort() + "/" + (svc.isEmpty() ? sid : svc);
    }

    private static String trim(String s) {
        return s == null ? "" : s.trim();
    }
}
