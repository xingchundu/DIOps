package com.dbops.legacy;

import com.dbops.config.DbopsProperties;
import com.dbops.security.AuthFilter;
import com.dbops.security.ClientIp;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Enumeration;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * 渐进式迁移网关：Java 尚未接管的 /api/**（自动化运维、SQL 工作台、报表、AI、SQL 优化代理等）原样转发给 Node 旧服务。
 * 前端只需要把 API 地址指向 Java 服务（默认端口 3000），Node 改到 LEGACY_NODE_URL（默认 3001）。
 * <ul>
 *   <li>请求体以流方式转发（支持 multipart 上传）</li>
 *   <li>响应以流方式回写并逐块 flush（支持 SSE / 大文件下载）</li>
 *   <li>Java 已接管前缀下的未知路径直接 404，不再转发</li>
 * </ul>
 */
@RestController
public class LegacyProxyController {

    private static final Logger log = LoggerFactory.getLogger(LegacyProxyController.class);
    private static final Set<String> HOP_BY_HOP = Set.of("connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
            "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length", "expect", "http2-settings");

    private final DbopsProperties.Legacy cfg;
    private final com.dbops.security.TokenRevocations revocations;
    private final boolean trustProxy;
    private final HttpClient client;

    private final com.dbops.security.JwtUtil jwt;

    public LegacyProxyController(DbopsProperties props, com.dbops.security.TokenRevocations revocations, com.dbops.security.JwtUtil jwt) {
        this.revocations = revocations;
        this.jwt = jwt;
        this.cfg = props.getLegacy();
        this.trustProxy = props.getSecurity().isTrustProxyEnabled();
        this.client = HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1)
                .connectTimeout(Duration.ofSeconds(5))
                .followRedirects(HttpClient.Redirect.NEVER)
                .build();
    }

    @RequestMapping("/api/**")
    public void proxy(HttpServletRequest req, HttpServletResponse res) throws IOException {
        // [fix] 带 context path 部署时 getRequestURI() 含前缀，原样拼进转发 URL 会让 Node 收到
        //       /xxx/api/... 而返回「接口不存在」。这里统一用去掉 context path 的路径做判断和转发。
        String uri = req.getRequestURI();
        String ctx = req.getContextPath();
        String path = (ctx != null && !ctx.isEmpty() && uri.startsWith(ctx)) ? uri.substring(ctx.length()) : uri;
        if (AuthFilter.isOwned(path)) {
            writeJson(res, 404, "{\"code\":404,\"msg\":\"接口不存在: " + req.getMethod() + " " + escape(path)
                    + "（该路径归 Java 网关所有但没有对应接口，请确认 jar 已按源码重新构建）\"}");
            return;
        }
        if (!cfg.isEnabled()) {
            writeJson(res, 503, "{\"code\":503,\"msg\":\"接口不存在: " + req.getMethod() + " " + escape(path)
                    + "（legacy 转发已关闭：请设置 LEGACY_NODE_ENABLED=true 并重启 Java 服务）\"}");
            return;
        }
        // 已退出的 token 不再转发给 Node（Node 只验签，不知道 Java 侧的退出）
        if (revocations.isRevoked(com.dbops.security.TokenRevocations.bearer(req.getHeader("Authorization")))) {
            writeJson(res, 401, "{\"code\":401,\"msg\":\"已退出登录，请重新登录\"}");
            return;
        }
        String qs = req.getQueryString();
        URI target;
        try {
            target = new URI(cfg.getNodeUrl().replaceAll("/+$", "") + path + (qs == null ? "" : "?" + qs));
        } catch (java.net.URISyntaxException e) {
            writeJson(res, 400, "{\"code\":400,\"msg\":\"请求地址包含非法字符\"}");
            return;
        }
        HttpRequest.Builder b = HttpRequest.newBuilder(target).timeout(Duration.ofSeconds(Math.max(10, cfg.getTimeoutSec())));
        Enumeration<String> names = req.getHeaderNames();
        while (names.hasMoreElements()) {
            String n = names.nextElement();
            if (HOP_BY_HOP.contains(n.toLowerCase(Locale.ROOT)) || n.equalsIgnoreCase("x-forwarded-for")
                    || n.toLowerCase(Locale.ROOT).startsWith("x-diops-gateway-")) {
                continue;   // 网关签发的头不接受客户端自带
            }
            Enumeration<String> vals = req.getHeaders(n);
            while (vals.hasMoreElements()) {
                try {
                    b.header(n, vals.nextElement());
                } catch (IllegalArgumentException ignore) {
                    // HttpClient 限制的头
                }
            }
        }
        Object verifiedRole = req.getAttribute(AuthFilter.VERIFIED_ROLE_ATTR);
        String bearer = com.dbops.security.TokenRevocations.bearer(req.getHeader("Authorization"));
        if (verifiedRole != null && bearer != null) {
            b.header("X-DIOps-Gateway-Role", String.valueOf(verifiedRole));
            b.header("X-DIOps-Gateway-Sig", jwt.gatewaySign(bearer, String.valueOf(verifiedRole)));
        }
        String xff = req.getHeader("X-Forwarded-For");
        String ip = ClientIp.of(req, trustProxy);
        b.header("X-Forwarded-For", xff == null || xff.isBlank() || !trustProxy ? ip : xff + ", " + req.getRemoteAddr());
        b.header("X-Forwarded-Proto", req.isSecure() ? "https" : req.getScheme());
        if (req.getHeader("Host") != null) {
            b.header("X-Forwarded-Host", req.getHeader("Host"));
        }

        String method = req.getMethod().toUpperCase(Locale.ROOT);
        // 缓冲请求体并由 HttpClient 自行设置 Content-Length。直接转发 InputStream 时，
        // 经 Node http-proxy 再转到 Python 易出现「Invalid HTTP request received」(400)。
        byte[] body = readRequestBody(req, method);
        if ("GET".equals(method)) {
            b.GET();
        } else if ("HEAD".equals(method)) {
            b.method("HEAD", HttpRequest.BodyPublishers.noBody());
        } else if (body.length > 0) {
            b.method(method, HttpRequest.BodyPublishers.ofByteArray(body));
        } else {
            b.method(method, HttpRequest.BodyPublishers.noBody());
        }

        HttpResponse<InputStream> upstream;
        try {
            upstream = client.send(b.build(), HttpResponse.BodyHandlers.ofInputStream());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            writeJson(res, 502, "{\"code\":502,\"msg\":\"旧服务请求被中断\"}");
            return;
        } catch (IOException e) {
            log.warn("[legacy-proxy] {} {} -> {}: {}", method, path, target, e.getMessage());
            writeJson(res, 502, "{\"code\":502,\"msg\":\"Node 旧服务未就绪（" + escape(cfg.getNodeUrl()) + "）\"}");
            return;
        }

        res.setStatus(upstream.statusCode());
        for (Map.Entry<String, List<String>> h : upstream.headers().map().entrySet()) {
            String n = h.getKey();
            if (n == null || n.startsWith(":") || HOP_BY_HOP.contains(n.toLowerCase(Locale.ROOT))
                    || n.toLowerCase(Locale.ROOT).startsWith("access-control-")) {
                continue;
            }
            for (String v : h.getValue()) {
                res.addHeader(n, v);
            }
        }
        upstream.headers().firstValueAsLong("content-length").ifPresent(res::setContentLengthLong);
        boolean sse = upstream.headers().firstValue("content-type").orElse("").contains("text/event-stream");
        if (sse) {
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("X-Accel-Buffering", "no");
        }
        try (InputStream in = upstream.body(); OutputStream out = res.getOutputStream()) {
            byte[] buf = new byte[sse ? 1024 : 16 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                if (sse) {
                    out.flush();
                }
            }
            out.flush();
        } catch (IOException e) {
            // 客户端断开（如关闭 SSE 页面）属正常
            log.debug("[legacy-proxy] stream closed: {}", e.getMessage());
        }
    }

    private static void writeJson(HttpServletResponse res, int status, String body) throws IOException {
        res.setStatus(status == 404 ? 404 : status);
        res.setContentType("application/json;charset=UTF-8");
        res.getOutputStream().write(body.getBytes(StandardCharsets.UTF_8));
    }

    private static String escape(String s) {
        return s == null ? "" : s.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    private static final int MAX_PROXY_BODY_BYTES = 20 * 1024 * 1024;

    /** GET/HEAD 不读体；其余方法在 Tomcat 允许时读入内存（上限 20MB，含 multipart）。 */
    static byte[] readRequestBody(HttpServletRequest req, String method) throws IOException {
        if ("GET".equals(method) || "HEAD".equals(method) || "OPTIONS".equals(method)) {
            return new byte[0];
        }
        long len = req.getContentLengthLong();
        if (len > MAX_PROXY_BODY_BYTES) {
            throw new IOException("请求体超过代理上限 " + MAX_PROXY_BODY_BYTES + " 字节");
        }
        if (len == 0 && req.getHeader("Transfer-Encoding") == null) {
            return new byte[0];
        }
        try (InputStream in = req.getInputStream()) {
            return in.readAllBytes();
        }
    }
}
