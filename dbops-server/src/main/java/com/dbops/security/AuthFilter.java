package com.dbops.security;

import com.dbops.common.Db;
import com.dbops.common.Values;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * JWT 认证（对应 Node authMiddleware），只拦截 Java 接管的接口前缀；转发给 Node 的接口由 Node 自行鉴权。
 * <p>
 * [fix] Node 版只验签：账号被禁用/降权后，旧 token 在 8 小时内仍然有效。这里每次请求按 30s 缓存回查 SYS_USER 的状态与角色。
 */
@Component
public class AuthFilter extends OncePerRequestFilter {

    private static final Logger log = LoggerFactory.getLogger(AuthFilter.class);

    /** Java 接管的接口前缀 */
    public static final List<String> OWNED_PREFIXES = List.of(
            "/api/auth", "/api/users", "/api/rbac", "/api/system-config",
            "/api/cmdb", "/api/monitor", "/api/alerts",
            // SQL 洞察（统一解析/审核/执行计划/采集/波动检测）；/api/sql 原 Node sql.js 已删除，由 Java 兼容实现
            "/api/sql-insight", "/api/sql",
            // 授权：status / activate 不需要登录，info 需要
            "/api/license",
            // dxc 2026-11-12 平台运维闭环（通知/治理/健康/SSO）
            "/api/platform");

    private static final List<String> PUBLIC_PATHS = List.of(
            "/api/auth/login", "/api/license/status", "/api/license/activate",
            "/api/platform/sso/sso-config", "/api/platform/sso/ldap-login",
            "/api/platform/sso/oidc/authorize-url", "/api/platform/sso/oidc/callback");
    private static final long STATUS_TTL_MS = 30_000;
    /** 平台库不可用时，缓存最多再沿用这么久，超过即拒绝 */
    private static final long STALE_MAX_MS = 5 * 60_000;
    public static final String VERIFIED_ROLE_ATTR = "dbops.verifiedRole";

    private final JwtUtil jwt;
    private final Db db;
    private final TokenRevocations revocations;
    private final ObjectMapper mapper = new ObjectMapper();
    private final Map<Long, CachedUser> cache = new ConcurrentHashMap<>();

    /** pwdChangedSec：最近一次改 / 重置密码的时间（秒）；早于它签发的 token 一律失效 */
    private record CachedUser(int status, String role, long pwdChangedSec, long loadedAt) {
    }

    public AuthFilter(JwtUtil jwt, Db db, TokenRevocations revocations) {
        this.jwt = jwt;
        this.db = db;
        this.revocations = revocations;
    }

    public static boolean isOwned(String path) {
        for (String p : OWNED_PREFIXES) {
            if (path.equals(p) || path.startsWith(p + "/")) {
                return true;
            }
        }
        return false;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String path = request.getRequestURI().substring(request.getContextPath().length());
        if ("OPTIONS".equalsIgnoreCase(request.getMethod())) {
            return true;
        }
        // 所有 /api/* 都经过这里：Java 自己的接口做完整认证；转发给 Node 的接口只要带了 token，
        // 也在网关统一检查“已退出 / 账号禁用 / 改密码后的旧 token”（Node 只验签，查不到这些状态）
        return !path.startsWith("/api/") || PUBLIC_PATHS.contains(path);
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        String header = req.getHeader("Authorization");
        String path = req.getRequestURI().substring(req.getContextPath().length());
        boolean owned = isOwned(path);
        if (!owned && (header == null || !header.startsWith("Bearer "))) {
            chain.doFilter(req, res);   // 不带 token 的转发请求由 Node 拒绝（或是 Node 的公开接口）
            return;
        }
        if (header == null || !header.startsWith("Bearer ")) {
            deny(res, "未授权，请先登录");
            return;
        }
        String token = header.substring(7).trim();
        if (revocations.isRevoked(token)) {
            deny(res, "已退出登录，请重新登录");
            return;
        }
        Map<String, Object> payload = jwt.verify(token);
        Long userId = payload == null ? null : Values.toLong(payload.get("userId"));
        if (userId == null) {
            deny(res, "Token已过期或无效，请重新登录");
            return;
        }
        String role = Values.str(payload.get("role"));
        CachedUser cu = loadUser(userId);
        if (cu == null) {
            // 平台库不可用且没有缓存：无法确认账号状态，拒绝（禁用的账号不能借数据库抖动继续操作）
            res.setStatus(503);
            res.setContentType("application/json;charset=UTF-8");
            res.getOutputStream().write(mapper.writeValueAsString(Map.of("code", 503, "msg", "暂时无法校验账号状态，请稍后重试"))
                    .getBytes(StandardCharsets.UTF_8));
            return;
        }
        if (cu.status != 1) {
            deny(res, "账号已被禁用或不存在，请联系管理员");
            return;
        }
        long iat = Values.toLong(payload.get("iat"), 0);
        if (cu.pwdChangedSec > 0 && iat > 0 && iat < cu.pwdChangedSec) {
            deny(res, "密码已修改，请重新登录");
            return;
        }
        role = cu.role;
        List<String> menus = new ArrayList<>();
        if (payload.get("menus") instanceof List<?> l) {
            for (Object o : l) {
                menus.add(String.valueOf(o));
            }
        }
        req.setAttribute(CurrentUser.REQUEST_ATTR, new CurrentUser(userId,
                Values.str(payload.get("username"), ""), role, Values.toLong(payload.get("tenantId")), menus));
        if (!owned) {
            // 转发给 Node：把网关查到的最新角色带过去，Node 以它为准（角色被降级后旧 token 里的角色不再生效）
            req.setAttribute(VERIFIED_ROLE_ATTR, role);
        }
        chain.doFilter(req, res);
    }

    /** 用户被禁用/改角色后立即失效缓存 */
    public void evict(long userId) {
        cache.remove(userId);
    }

    private CachedUser loadUser(long userId) {
        long now = System.currentTimeMillis();
        CachedUser c = cache.get(userId);
        if (c != null && now - c.loadedAt < STATUS_TTL_MS) {
            return c;
        }
        try {
            Map<String, Object> row = db.one("SELECT STATUS, ROLE, PWD_CHANGED FROM SYS_USER WHERE USER_ID = ?", userId);
            if (row == null) {
                c = new CachedUser(0, null, 0, now);
            } else {
                long pwd = row.get("PWD_CHANGED") instanceof java.sql.Timestamp t ? t.getTime() / 1000 : 0;
                c = new CachedUser(Values.toInt(row.get("STATUS"), 0), Values.str(row.get("ROLE")), pwd, now);
            }
            cache.put(userId, c);
            return c;
        } catch (Exception e) {
            // 平台库短暂不可用：缓存不超过 5 分钟时沿用，否则返回 null 由调用方拒绝
            log.warn("[auth] load user status failed: {}", e.getMessage());
            return c != null && now - c.loadedAt < STALE_MAX_MS ? c : null;
        }
    }

    private void deny(HttpServletResponse res, String msg) throws IOException {
        res.setStatus(401);
        res.setContentType("application/json;charset=UTF-8");
        res.getOutputStream().write(mapper.writeValueAsString(Map.of("code", 401, "msg", msg)).getBytes(StandardCharsets.UTF_8));
    }
}
