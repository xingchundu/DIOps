package com.dbops.license;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 授权拦截：作用于所有 /api/*（包括 Java 网关转发给 Node 的接口），在登录校验之前执行。
 * 授权无效 / 到期 → HTTP 403 + {code: 4031, msg}，前端据此回到登录页并提示。
 * 放行：授权自身的接口、健康检查、退出登录。
 */
@Component
public class LicenseFilter extends OncePerRequestFilter {

    public static final int CODE = 4031;
    private static final List<String> OPEN_PREFIXES = List.of("/api/license/", "/api/health");
    private static final List<String> OPEN_PATHS = List.of("/api/auth/logout");

    private final LicenseService license;
    private final ObjectMapper mapper = new ObjectMapper();

    public LicenseFilter(LicenseService license) {
        this.license = license;
    }

    static boolean open(String path) {
        if (OPEN_PATHS.contains(path)) {
            return true;
        }
        for (String p : OPEN_PREFIXES) {
            if (path.startsWith(p) || path.equals(p.endsWith("/") ? p.substring(0, p.length() - 1) : p)) {
                return true;
            }
        }
        return false;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String path = request.getRequestURI().substring(request.getContextPath().length());
        return "OPTIONS".equalsIgnoreCase(request.getMethod()) || !path.startsWith("/api/") || open(path);
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain) throws ServletException, IOException {
        if (license.loginAllowed()) {
            chain.doFilter(req, res);
            return;
        }
        LicenseCodec.Status s = license.status();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", CODE);
        body.put("msg", s.message());
        body.put("data", Map.of("state", s.state().name()));
        res.setStatus(403);
        res.setContentType("application/json;charset=UTF-8");
        res.getOutputStream().write(mapper.writeValueAsString(body).getBytes(StandardCharsets.UTF_8));
    }
}
