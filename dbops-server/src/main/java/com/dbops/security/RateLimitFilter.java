package com.dbops.security;

import com.dbops.config.DbopsProperties;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 按 IP 的固定窗口限流（同 Node express-rate-limit 配置）：全局 5 分钟 RATE_LIMIT_MAX 次，登录 5 分钟 RATE_LIMIT_AUTH_MAX 次。
 */
@Component
public class RateLimitFilter extends OncePerRequestFilter {

    private static final long WINDOW_MS = 5 * 60 * 1000L;

    private final int globalMax;
    private final int authMax;
    private final boolean trustProxy;
    private final Map<String, Window> global = new ConcurrentHashMap<>();
    private final Map<String, Window> auth = new ConcurrentHashMap<>();

    private static final class Window {
        final long start;
        final AtomicInteger count = new AtomicInteger();

        Window(long start) {
            this.start = start;
        }
    }

    public RateLimitFilter(DbopsProperties props) {
        this.globalMax = Math.max(100, props.getSecurity().getRateLimitMax());
        this.authMax = Math.max(5, props.getSecurity().getRateLimitAuthMax());
        this.trustProxy = props.getSecurity().isTrustProxyEnabled();
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        String ip = ClientIp.of(req, trustProxy);
        if (!hit(global, ip, globalMax, res)) {
            reject(res, "请求过于频繁，请稍后再试");
            return;
        }
        // 去掉 contextPath 再比较（部署在 /diops 等子路径下时 requestURI 带前缀，原来登录限流因此失效）
        String uri = req.getRequestURI();
        String ctx = req.getContextPath();
        if (ctx != null && !ctx.isEmpty() && uri.startsWith(ctx)) {
            uri = uri.substring(ctx.length());
        }
        while (uri.endsWith("/") && uri.length() > 1) {
            uri = uri.substring(0, uri.length() - 1);
        }
        if ("/api/auth/login".equals(uri) && !hit(auth, ip, authMax, null)) {
            reject(res, "登录尝试过于频繁，请稍后再试");
            return;
        }
        chain.doFilter(req, res);
    }

    private boolean hit(Map<String, Window> map, String key, int max, HttpServletResponse res) {
        long now = System.currentTimeMillis();
        Window w = map.compute(key, (k, old) -> (old == null || now - old.start >= WINDOW_MS) ? new Window(now) : old);
        int c = w.count.incrementAndGet();
        if (res != null) {
            res.setHeader("RateLimit-Limit", String.valueOf(max));
            res.setHeader("RateLimit-Remaining", String.valueOf(Math.max(0, max - c)));
            res.setHeader("RateLimit-Reset", String.valueOf(Math.max(0, (w.start + WINDOW_MS - now) / 1000)));
        }
        return c <= max;
    }

    private void reject(HttpServletResponse res, String msg) throws IOException {
        res.setStatus(429);
        res.setContentType("application/json;charset=UTF-8");
        res.getOutputStream().write(("{\"code\":429,\"msg\":\"" + msg + "\"}").getBytes(StandardCharsets.UTF_8));
    }

    @Scheduled(fixedDelay = 5 * 60 * 1000L)
    public void cleanup() {
        long now = System.currentTimeMillis();
        global.values().removeIf(w -> now - w.start >= WINDOW_MS);
        auth.values().removeIf(w -> now - w.start >= WINDOW_MS);
    }
}
