package com.dbops.security;

import com.dbops.config.DbopsProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.Set;

@Configuration
public class SecurityBeans {

    private static final Logger log = LoggerFactory.getLogger(SecurityBeans.class);

    /** 文档/模板中出现过的占位密钥，一律视为未配置 */
    static final Set<String> INSECURE = Set.of("", "dbops_secret", "dbops_platform_secret_2026",
            "请换成至少32位的随机字符串", "请换成足够长的随机串");

    /**
     * [fix] Node 版缺省回落到固定串 'dbops_secret'，可直接伪造 ADMIN token。
     * 这里：未配置/弱密钥拒绝启动（启动脚本自动生成强密钥）。
     */
    @Bean
    public JwtUtil jwtUtil(DbopsProperties props) {
        DbopsProperties.Security sec = props.getSecurity();
        String secret = sec.getJwtSecret() == null ? "" : sec.getJwtSecret().trim();
        if (INSECURE.contains(secret) || secret.length() < 16) {
            // 不再回退到公开的默认密钥（任何人都能用它伪造 ADMIN token）。启动脚本会自动生成强密钥写入 backend/.env；
            // 只有显式设置 DBOPS_ALLOW_WEAK_SECRET=true 的本地开发环境才允许弱密钥，且使用本次进程随机生成的密钥。
            boolean allowWeak = "true".equalsIgnoreCase(System.getenv("DBOPS_ALLOW_WEAK_SECRET"))
                    || "true".equalsIgnoreCase(System.getProperty("DBOPS_ALLOW_WEAK_SECRET"));
            if (sec.isProductionMode() || !allowWeak) {
                throw new IllegalStateException("JWT_SECRET 未配置或过于简单（需 >=16 位随机串）。请使用 start-all 启动（会自动生成），"
                        + "或在 backend/.env 中配置 JWT_SECRET");
            }
            log.warn("[auth] JWT_SECRET 过弱，DBOPS_ALLOW_WEAK_SECRET=true：使用进程内随机密钥（重启后所有 token 失效，且 Node 无法验签）");
            byte[] b = new byte[32];
            new java.security.SecureRandom().nextBytes(b);
            secret = java.util.Base64.getEncoder().encodeToString(b);
        }
        return new JwtUtil(secret, sec.getJwtExpires());
    }
}
