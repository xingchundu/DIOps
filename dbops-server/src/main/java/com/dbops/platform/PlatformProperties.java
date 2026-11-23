package com.dbops.platform;

import com.dbops.service.SystemConfigService;
import org.springframework.stereotype.Component;

/**
 * 阶段3交付配置（SYS_CONFIG）。
 * 修改者: dxc | 时间: 2026-11-12
 */
@Component
public class PlatformProperties {

    private final SystemConfigService cfg;

    public PlatformProperties(SystemConfigService cfg) {
        this.cfg = cfg;
    }

    public boolean deliveryEnabled() {
        return cfg.getBool("platform.enabled", cfg.getBool("phase3.delivery.enabled", false));
    }

    public boolean openApiEnabled() {
        return deliveryEnabled() && cfg.getBool("platform.openapi.enabled", true);
    }

    public boolean ssoEnabled() {
        return deliveryEnabled() && cfg.getBool("platform.sso.enabled", false);
    }

    public String ssoMode() {
        return cfg.get("platform.sso.mode", "LOCAL").trim().toUpperCase();
    }

    public boolean ldapEnabled() {
        if (!ssoEnabled()) {
            return false;
        }
        String m = ssoMode();
        return m.contains("LDAP");
    }

    public boolean oidcEnabled() {
        if (!ssoEnabled()) {
            return false;
        }
        String m = ssoMode();
        return m.contains("OIDC");
    }

    public boolean autoProvision() {
        return cfg.getBool("platform.sso.auto_provision", false);
    }

    public String defaultRole() {
        return cfg.get("platform.sso.default_role", "VIEWER");
    }

    public String ldapUrl() {
        return cfg.get("platform.sso.ldap.url", "");
    }

    public String ldapUserDnPattern() {
        return cfg.get("platform.sso.ldap.user_dn_pattern", "uid={username}");
    }

    public String ldapDomain() {
        return cfg.get("platform.sso.ldap.domain", "");
    }

    public String oidcIssuer() {
        return trimSlash(cfg.get("platform.sso.oidc.issuer", ""));
    }

    public String oidcClientId() {
        return cfg.get("platform.sso.oidc.client_id", "");
    }

    public String oidcClientSecret() {
        return cfg.get("platform.sso.oidc.client_secret", "");
    }

    public String oidcRedirectUri() {
        return cfg.get("platform.sso.oidc.redirect_uri", "");
    }

    public String oidcScopes() {
        return cfg.get("platform.sso.oidc.scopes", "openid profile");
    }

    public boolean healthEnabled() {
        return deliveryEnabled() && cfg.getBool("platform.health.enabled", true);
    }

    public long collectWarnPct() {
        return cfg.getLong("platform.health.collect_warn_pct", 85);
    }

    public long outboxWarn() {
        return cfg.getLong("platform.health.outbox_warn", 50);
    }

    public long backupFailWarn() {
        return cfg.getLong("platform.health.backup_fail_warn", 3);
    }

    public long sqlInsightOpenWarn() {
        return cfg.getLong("platform.health.sqlinsight_open_warn", 200);
    }

    private static String trimSlash(String u) {
        if (u == null || u.isEmpty()) {
            return "";
        }
        return u.endsWith("/") ? u.substring(0, u.length() - 1) : u;
    }
}
