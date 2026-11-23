package com.dbops.controller;

import com.dbops.common.Db;
import com.dbops.common.R;
import com.dbops.common.Values;
import com.dbops.config.DbopsProperties;
import com.dbops.security.AuthFilter;
import com.dbops.security.ClientIp;
import com.dbops.security.CurrentUser;
import com.dbops.security.JwtUtil;
import com.dbops.security.TokenRevocations;
import com.dbops.service.AuditService;
import com.dbops.service.RbacService;
import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.security.crypto.bcrypt.BCrypt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * /api/auth（同 Node routes/auth.js）
 */
@RestController
@RequestMapping("/api/auth")
public class AuthController {

    private static final Logger log = LoggerFactory.getLogger(AuthController.class);
    static final Pattern STRONG_PWD = Pattern.compile("^(?=.*[a-z])(?=.*[A-Z])(?=.*\\d).{8,}$");
    /** 恒定时间：用户不存在时也做一次 bcrypt 比较，防止通过响应时间枚举用户名 */
    private static final String DUMMY_HASH = BCrypt.hashpw("dummy-password", BCrypt.gensalt(10));

    private final Db db;
    private final JwtUtil jwt;
    private final RbacService rbac;
    private final AuditService audit;
    private final AuthFilter authFilter;
    private final TokenRevocations revocations;
    private final boolean trustProxy;

    public AuthController(Db db, JwtUtil jwt, RbacService rbac, AuditService audit, AuthFilter authFilter, TokenRevocations revocations,
                          DbopsProperties props) {
        this.revocations = revocations;
        this.db = db;
        this.jwt = jwt;
        this.rbac = rbac;
        this.audit = audit;
        this.authFilter = authFilter;
        this.trustProxy = props.getSecurity().isTrustProxyEnabled();
    }

    static boolean checkPassword(String plain, String hash) {
        if (plain == null || hash == null || hash.isEmpty()) {
            return false;
        }
        try {
            return BCrypt.checkpw(plain, hash);
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    /** 统一的新密码校验，返回错误信息或 null */
    static String validateNewPassword(String pwd) {
        if (pwd == null || pwd.length() < 8) {
            return "密码长度不能少于8位";
        }
        if (pwd.getBytes(StandardCharsets.UTF_8).length > 72) {
            return "密码长度不能超过72字节";
        }
        if (!STRONG_PWD.matcher(pwd).matches()) {
            return "密码需包含大小写字母和数字（至少8位）";
        }
        return null;
    }

    static String hashPassword(String pwd) {
        return BCrypt.hashpw(pwd, BCrypt.gensalt(10));
    }

    @PostMapping("/login")
    public Map<String, Object> login(@RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
        String username = Values.str(Values.get(body, "username"));
        String password = Values.raw(Values.get(body, "password"));
        if (username == null || password == null || password.isEmpty()) {
            return R.badRequest("用户名和密码不能为空");
        }
        String ip = ClientIp.of(req, trustProxy);
        try {
            Map<String, Object> user = db.one("SELECT USER_ID, USERNAME, PASSWORD_HASH, REAL_NAME, EMAIL, PHONE, ROLE, STATUS, "
                    + "TENANT_ID, LAST_LOGIN FROM SYS_USER WHERE USERNAME = ?", username);
            String hash = user == null ? DUMMY_HASH : Values.str(user.get("PASSWORD_HASH"), "");
            boolean match = checkPassword(password, hash);
            if (user == null || !match) {
                audit.log(null, username, "LOGIN_FAIL", null, null, ip, "FAIL", "密码错误");
                return R.fail(401, "用户名或密码错误");
            }
            // [fix] Node 版先判断禁用再校验密码：不知道密码也能探测出“账号存在且被禁用”
            if (Values.toInt(user.get("STATUS"), 0) != 1) {
                return R.fail(403, "账号已被禁用，请联系管理员");
            }
            long userId = Values.toLong(user.get("USER_ID"), 0);
            db.update("UPDATE SYS_USER SET LAST_LOGIN = SYSTIMESTAMP WHERE USER_ID = ?", userId);
            audit.log(userId, username, "LOGIN", null, null, ip, "SUCCESS", null);
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
        } catch (Exception e) {
            log.error("Login error", e);
            return R.fail(500, "服务器内部错误");
        }
    }

    @PostMapping("/logout")
    public Map<String, Object> logout(CurrentUser u, HttpServletRequest req) {
        String token = TokenRevocations.bearer(req.getHeader("Authorization"));
        Map<String, Object> payload = token == null ? null : jwt.verify(token);
        revocations.revoke(token, payload == null ? 0 : Values.toLong(payload.get("exp"), 0));
        audit.log(u.userId(), u.username(), "LOGOUT", null, null, ClientIp.of(req, trustProxy), "SUCCESS", null);
        return R.msg("已退出登录");
    }

    @GetMapping("/profile")
    public Map<String, Object> profile(CurrentUser u) {
        Map<String, Object> row = db.one("SELECT USER_ID, USERNAME, REAL_NAME, EMAIL, PHONE, ROLE, STATUS, LAST_LOGIN, CREATED_AT, TENANT_ID "
                + "FROM SYS_USER WHERE USER_ID = ?", u.userId());
        if (row == null) {
            return R.notFound("用户不存在");
        }
        List<String> menus = rbac.menuPathsForRole(Values.str(row.get("ROLE")));
        return R.ok(R.map(
                "userId", row.get("USER_ID"),
                "username", row.get("USERNAME"),
                "realName", row.get("REAL_NAME"),
                "email", row.get("EMAIL"),
                "phone", row.get("PHONE"),
                "role", row.get("ROLE"),
                "status", row.get("STATUS"),
                "lastLogin", row.get("LAST_LOGIN"),
                "createdAt", row.get("CREATED_AT"),
                "tenantId", row.get("TENANT_ID"),
                "menus", menus));
    }

    @PutMapping("/profile")
    public Map<String, Object> updateProfile(CurrentUser u, @RequestBody(required = false) Map<String, Object> body) {
        db.update("UPDATE SYS_USER SET REAL_NAME=?, EMAIL=?, PHONE=?, UPDATED_AT=SYSTIMESTAMP WHERE USER_ID=?",
                Values.str(Values.get(body, "realName")), Values.str(Values.get(body, "email")),
                Values.str(Values.get(body, "phone")), u.userId());
        return R.msg("个人信息更新成功");
    }

    @PostMapping("/change-password")
    public Map<String, Object> changePassword(CurrentUser u, @RequestBody(required = false) Map<String, Object> body,
                                              HttpServletRequest req) {
        String oldPwd = Values.raw(Values.get(body, "oldPassword"));
        String newPwd = Values.raw(Values.get(body, "newPassword"));
        String confirm = Values.raw(Values.get(body, "confirmPassword"));
        if (Values.isBlank(oldPwd) || Values.isBlank(newPwd) || Values.isBlank(confirm)) {
            return R.badRequest("请填写完整密码信息");
        }
        if (!newPwd.equals(confirm)) {
            return R.badRequest("两次新密码输入不一致");
        }
        String err = validateNewPassword(newPwd);
        if (err != null) {
            return R.badRequest("新" + err);
        }
        Map<String, Object> row = db.one("SELECT PASSWORD_HASH FROM SYS_USER WHERE USER_ID = ?", u.userId());
        if (row == null) {
            return R.notFound("用户不存在");
        }
        if (!checkPassword(oldPwd, Values.str(row.get("PASSWORD_HASH")))) {
            return R.badRequest("原密码错误");
        }
        db.update("UPDATE SYS_USER SET PASSWORD_HASH=?, PWD_CHANGED=SYSTIMESTAMP, UPDATED_AT=SYSTIMESTAMP WHERE USER_ID=?",
                hashPassword(newPwd), u.userId());
        // 改密码后该用户所有已签发的 token（包括当前这个）失效：AuthFilter 比较 token 的 iat 与 PWD_CHANGED
        authFilter.evict(u.userId());
        audit.log(u.userId(), u.username(), "CHANGE_PASSWORD", null, null, ClientIp.of(req, trustProxy), "SUCCESS", null);
        return R.msg("密码修改成功，请重新登录");
    }

    @PostMapping("/reset-password")
    public Map<String, Object> resetPassword(CurrentUser u, @RequestBody(required = false) Map<String, Object> body,
                                             HttpServletRequest req) {
        if (!u.isAdmin()) {
            return R.forbidden();
        }
        Long userId = Values.toLong(Values.get(body, "userId"));
        String newPwd = Values.raw(Values.get(body, "newPassword"));
        if (userId == null || Values.isBlank(newPwd)) {
            return R.badRequest("参数缺失");
        }
        String err = validateNewPassword(newPwd);
        if (err != null) {
            return R.badRequest(err);
        }
        int n = db.update("UPDATE SYS_USER SET PASSWORD_HASH=?, PWD_CHANGED=SYSTIMESTAMP, UPDATED_AT=SYSTIMESTAMP WHERE USER_ID=?",
                hashPassword(newPwd), userId);
        if (n == 0) {
            return R.notFound("用户不存在");
        }
        authFilter.evict(userId);
        audit.log(u.userId(), u.username(), "RESET_PASSWORD", null, String.valueOf(userId), ClientIp.of(req, trustProxy),
                "SUCCESS", "重置用户ID=" + userId + "密码");
        return R.msg("密码重置成功");
    }
}
