package com.dbops.platform.sso;

import com.dbops.platform.PlatformProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import javax.naming.Context;
import javax.naming.NamingException;
import javax.naming.directory.InitialDirContext;
import java.util.Hashtable;

/**
 * LDAP bind 认证（JNDI，无 Spring Security）。
 * 修改者: dxc | 时间: 2026-11-12
 */
@Service
public class LdapAuthService {

    private static final Logger log = LoggerFactory.getLogger(LdapAuthService.class);

    private final PlatformProperties props;

    public LdapAuthService(PlatformProperties props) {
        this.props = props;
    }

    public boolean authenticate(String username, String password) {
        if (!props.ldapEnabled()) {
            return false;
        }
        if (username == null || username.isBlank() || password == null || password.isEmpty()) {
            return false;
        }
        String url = props.ldapUrl();
        if (url == null || url.isBlank()) {
            throw new IllegalStateException("未配置 platform.sso.ldap.url");
        }
        String principal = buildPrincipal(username.trim());
        Hashtable<String, String> env = new Hashtable<>();
        env.put(Context.INITIAL_CONTEXT_FACTORY, "com.sun.jndi.ldap.LdapCtxFactory");
        env.put(Context.PROVIDER_URL, url.trim());
        env.put(Context.SECURITY_AUTHENTICATION, "simple");
        env.put(Context.SECURITY_PRINCIPAL, principal);
        env.put(Context.SECURITY_CREDENTIALS, password);
        env.put("com.sun.jndi.ldap.connect.timeout", "8000");
        env.put("com.sun.jndi.ldap.read.timeout", "8000");
        try {
            InitialDirContext ctx = new InitialDirContext(env);
            ctx.close();
            return true;
        } catch (NamingException e) {
            log.debug("[phase3-ldap] bind failed for {}: {}", username, e.getMessage());
            return false;
        }
    }

    String buildPrincipal(String username) {
        String domain = props.ldapDomain();
        if (domain != null && !domain.isBlank()) {
            return username.contains("@") ? username : username + "@" + domain.trim();
        }
        return props.ldapUserDnPattern().replace("{username}", username);
    }
}
