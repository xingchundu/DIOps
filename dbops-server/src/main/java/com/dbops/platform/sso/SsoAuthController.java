package com.dbops.platform.sso;

import com.dbops.common.R;
import com.dbops.common.Values;
import com.dbops.security.ClientIp;
import com.dbops.config.DbopsProperties;
import com.dbops.platform.PlatformProperties;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 阶段3 SSO 登录（JWT 签发与 /api/auth/login 一致）。
 * 修改者: dxc | 时间: 2026-11-12
 */
@RestController
@RequestMapping("/api/platform/sso")
public class SsoAuthController {

    private final PlatformProperties props;
    private final LdapAuthService ldap;
    private final OidcAuthService oidc;
    private final SsoSessionService session;
    private final boolean trustProxy;

    public SsoAuthController(PlatformProperties props, LdapAuthService ldap, OidcAuthService oidc,
                                  SsoSessionService session, DbopsProperties dbops) {
        this.props = props;
        this.ldap = ldap;
        this.oidc = oidc;
        this.session = session;
        this.trustProxy = dbops.getSecurity().isTrustProxyEnabled();
    }

    @GetMapping("/sso-config")
    public Map<String, Object> ssoConfig() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("deliveryEnabled", props.deliveryEnabled());
        m.put("ssoEnabled", props.ssoEnabled());
        m.put("ldapEnabled", props.ldapEnabled());
        m.put("oidcEnabled", props.oidcEnabled());
        if (props.oidcEnabled()) {
            m.put("oidc", oidc.publicConfig());
        }
        return R.ok(m);
    }

    @PostMapping("/ldap-login")
    public Map<String, Object> ldapLogin(@RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
        if (!props.ldapEnabled()) {
            return R.fail(400, "LDAP 登录未启用");
        }
        String username = Values.str(Values.get(body, "username"));
        String password = Values.raw(Values.get(body, "password"));
        if (username == null || password == null || password.isEmpty()) {
            return R.badRequest("用户名和密码不能为空");
        }
        if (!ldap.authenticate(username, password)) {
            return R.fail(401, "LDAP 认证失败");
        }
        return session.loginAfterSso(username, "LDAP", ClientIp.of(req, trustProxy));
    }

    @GetMapping("/oidc/authorize-url")
    public Map<String, Object> oidcAuthorizeUrl(@RequestParam(required = false) String state) {
        if (!props.oidcEnabled()) {
            return R.fail(400, "OIDC 未启用");
        }
        return R.ok(Map.of("url", oidc.buildAuthorizationUrl(state)));
    }

    @PostMapping("/oidc/callback")
    public Map<String, Object> oidcCallback(@RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
        if (!props.oidcEnabled()) {
            return R.fail(400, "OIDC 未启用");
        }
        String code = Values.str(Values.get(body, "code"));
        String username = oidc.usernameFromAuthorizationCode(code);
        return session.loginAfterSso(username, "OIDC", ClientIp.of(req, trustProxy));
    }
}
