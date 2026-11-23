package com.dbops.security;

import com.dbops.config.AllowedOrigins;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.nio.charset.StandardCharsets;

/**
 * 写请求来源校验（同 Node security.js）：带 Origin 必须在白名单；无 Origin 但带 Referer 时 Referer 必须匹配。
 * 同时补齐 helmet 的常用安全响应头。
 */
@Component
public class OriginCheckFilter extends OncePerRequestFilter {

    private final AllowedOrigins origins;

    public OriginCheckFilter(AllowedOrigins origins) {
        this.origins = origins;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("X-Frame-Options", "SAMEORIGIN");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("X-DNS-Prefetch-Control", "off");

        String method = req.getMethod().toUpperCase();
        String path = req.getRequestURI();
        boolean safe = method.equals("GET") || method.equals("HEAD") || method.equals("OPTIONS");
        if (!safe && !"/health".equals(path)) {
            String origin = req.getHeader("Origin");
            if (origin != null) {
                if (!origins.allows(origin)) {
                    reject(res);
                    return;
                }
            } else {
                String referer = req.getHeader("Referer");
                if (referer != null && !origins.allowsReferer(referer)) {
                    reject(res);
                    return;
                }
            }
        }
        chain.doFilter(req, res);
    }

    private void reject(HttpServletResponse res) throws IOException {
        res.setStatus(403);
        res.setContentType("application/json;charset=UTF-8");
        res.getOutputStream().write("{\"code\":403,\"msg\":\"请求来源不被允许\"}".getBytes(StandardCharsets.UTF_8));
    }
}
