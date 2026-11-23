package com.dbops;

import com.dbops.config.EnvFileLoader;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * 数据库智能平台 Java 后端入口。
 * <p>
 * 本服务接管核心监控链路（/api/auth、/api/users、/api/rbac、/api/system-config、/api/cmdb、/api/monitor、/api/alerts），
 * 其余 /api/** 由 {@link com.dbops.legacy.LegacyProxyController} 透明转发到 Node 旧服务，前端无需改动。
 */
@SpringBootApplication(exclude = DataSourceAutoConfiguration.class)
@ConfigurationPropertiesScan
@EnableScheduling
public class DbopsApplication {

    public static void main(String[] args) {
        // 与 Node 共用 backend/.env；环境变量优先，.env 只补缺
        EnvFileLoader.load();
        // Oracle TIMESTAMP/DATE 统一映射为 java.sql.Timestamp（否则 getObject 返回 oracle.sql.TIMESTAMP，JSON 序列化异常）
        System.setProperty("oracle.jdbc.J2EE13Compliant", "true");
        SpringApplication.run(DbopsApplication.class, args);
    }
}
