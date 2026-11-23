package com.dbops.platform.sso;

import com.dbops.platform.PlatformProperties;
import com.dbops.common.Db;
import com.dbops.common.R;
import com.dbops.common.Values;
import com.dbops.security.AuthFilter;
import com.dbops.security.JwtUtil;
import com.dbops.service.AuditService;
import com.dbops.service.RbacService;
import org.springframework.security.crypto.bcrypt.BCrypt;
import org.springframework.stereotype.Service;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * SSO 成功后签发 JWT（与本地登录响应一致）。
 * 修改者: dxc | 时间: 2026-11-12
 */
@Service
public class SsoSessionService {

    private final Db db;
    private final JwtUtil jwt;
    private final RbacService rbac;
    private final AuditService audit;
    private final AuthFilter authFilter;
    private final PlatformProperties props;

    public SsoSessionService(Db db, JwtUtil jwt, RbacService rbac, AuditService audit, AuthFilter authFilter,
                                PlatformProperties props) {
        this.db = db;
        this.jwt = jwt;
        this.rbac = rbac;
        this.audit = audit;
        this.authFilter = authFilter;
        this.props = props;
    }

    public Map<String, Object> loginAfterSso(String username, String ssoMode, String ip) {
        Map<String, Object> user = db.one(
                "SELECT USER_ID, USERNAME, PASSWORD_HASH, REAL_NAME, EMAIL, PHONE, ROLE, STATUS, TENANT_ID, LAST_LOGIN "
                        + "FROM SYS_USER WHERE USERNAME = ?", username);
        if (user == null) {
            if (!props.autoProvision()) {
                logSso(username, ssoMode, "FAIL", "无本地映射用户", ip);
                return R.fail(403, "SSO 认证通过，但平台未开通该账号，请联系管理员");
            }
            long id = db.insertReturningId(
                    "INSERT INTO SYS_USER (USERNAME, PASSWORD_HASH, REAL_NAME, ROLE, STATUS, TENANT_ID) VALUES (?,?,?,?,1,1)",
                    "USER_ID", username, BCrypt.hashpw(java.util.UUID.randomUUID().toString(), BCrypt.gensalt(10)), username, props.defaultRole());
            user = db.one("SELECT USER_ID, USERNAME, PASSWORD_HASH, REAL_NAME, EMAIL, PHONE, ROLE, STATUS, TENANT_ID, LAST_LOGIN "
                    + "FROM SYS_USER WHERE USER_ID = ?", id);
        }
        if (Values.toInt(user.get("STATUS"), 0) != 1) {
            logSso(username, ssoMode, "FAIL", "账号禁用", ip);
            return R.fail(403, "账号已被禁用，请联系管理员");
        }
        long userId = Values.toLong(user.get("USER_ID"), 0);
        db.update("UPDATE SYS_USER SET LAST_LOGIN = SYSTIMESTAMP WHERE USER_ID = ?", userId);
        audit.log(userId, username, "SSO_LOGIN", null, ssoMode, ip, "SUCCESS", null);
        logSso(username, ssoMode, "SUCCESS", null, ip);
        authFilter.evict(userId);
        String role = Values.str(user.get("ROLE"));
        List<String> menus = rbac.menuPathsForRole(role);
        Map<String, Object> claims = new HashMap<>();
        claims.put("userId", userId);
        claims.put("username", user.get("USERNAME"));
        claims.put("role", role);
        claims.put("tenantId", Values.toLong(user.get("TENANT_ID")));
        claims.put("menus", menus);
        String token = jwt.sign(claims);
        return R.ok(R.map("token", token, "user", R.map(
                "userId", userId,
                "username", user.get("USERNAME"),
                "realName", user.get("REAL_NAME"),
                "email", user.get("EMAIL"),
                "phone", user.get("PHONE"),
                "role", role,
                "lastLogin", user.get("LAST_LOGIN"),
                "tenantId", user.get("TENANT_ID"),
                "menus", menus)), "登录成功");
    }

    private void logSso(String username, String mode, String result, String detail, String ip) {
        try {
            db.update("INSERT INTO SSO_LOGIN_LOG (USERNAME, SSO_MODE, RESULT, DETAIL, CLIENT_IP) VALUES (?,?,?,?,?)",
                    username, mode, result, detail, ip);
        } catch (Exception ignored) {
            // 表未迁移时不阻塞登录
        }
    }

}
