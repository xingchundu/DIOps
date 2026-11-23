package com.dbops.platform.sso;

import com.dbops.platform.PlatformProperties;
import com.dbops.common.Values;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * OIDC 授权码换票并解析 id_token（最小实现，无 spring-security-oauth2）。
 * 修改者: dxc | 时间: 2026-11-12
 */
@Service
public class OidcAuthService {

    private static final Logger log = LoggerFactory.getLogger(OidcAuthService.class);

    private final PlatformProperties props;
    private final ObjectMapper mapper = new ObjectMapper();
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();

    public OidcAuthService(PlatformProperties props) {
        this.props = props;
    }

    public Map<String, Object> publicConfig() {
        Map<String, Object> m = new LinkedHashMap<>();
        if (!props.oidcEnabled()) {
            return m;
        }
        String issuer = props.oidcIssuer();
        String clientId = props.oidcClientId();
        String redirect = props.oidcRedirectUri();
        if (issuer.isEmpty() || clientId.isEmpty() || redirect.isEmpty()) {
            return m;
        }
        m.put("issuer", issuer);
        m.put("clientId", clientId);
        m.put("redirectUri", redirect);
        m.put("scopes", props.oidcScopes());
        m.put("authorizationEndpoint", issuer + "/protocol/openid-connect/auth");
        return m;
    }

    public String buildAuthorizationUrl(String state) {
        Map<String, Object> c = publicConfig();
        if (c.isEmpty()) {
            throw new IllegalStateException("OIDC 未完整配置");
        }
        String st = state == null || state.isBlank() ? UUID.randomUUID().toString() : state;
        String q = "response_type=code&client_id=" + enc(props.oidcClientId())
                + "&redirect_uri=" + enc(props.oidcRedirectUri())
                + "&scope=" + enc(props.oidcScopes())
                + "&state=" + enc(st);
        return Values.str(c.get("authorizationEndpoint")) + "?" + q;
    }

    public String usernameFromAuthorizationCode(String code) {
        if (code == null || code.isBlank()) {
            throw new IllegalArgumentException("缺少 code");
        }
        String issuer = props.oidcIssuer();
        String tokenUrl = issuer + "/protocol/openid-connect/token";
        String body = "grant_type=authorization_code&code=" + enc(code)
                + "&redirect_uri=" + enc(props.oidcRedirectUri())
                + "&client_id=" + enc(props.oidcClientId())
                + "&client_secret=" + enc(props.oidcClientSecret());
        try {
            HttpRequest req = HttpRequest.newBuilder(URI.create(tokenUrl))
                    .timeout(Duration.ofSeconds(20))
                    .header("Content-Type", "application/x-www-form-urlencoded")
                    .POST(HttpRequest.BodyPublishers.ofString(body))
                    .build();
            HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString());
            if (res.statusCode() >= 400) {
                throw new IllegalStateException("Token 端点失败 HTTP " + res.statusCode());
            }
            JsonNode root = mapper.readTree(res.body());
            String idToken = root.path("id_token").asText(null);
            if (idToken == null || idToken.isEmpty()) {
                throw new IllegalStateException("响应无 id_token");
            }
            return extractUsername(idToken);
        } catch (Exception e) {
            log.warn("[phase3-oidc] token exchange: {}", e.getMessage());
            throw new IllegalStateException("OIDC 换票失败: " + e.getMessage(), e);
        }
    }

    private String extractUsername(String idToken) {
        String[] parts = idToken.split("\\.");
        if (parts.length < 2) {
            throw new IllegalStateException("id_token 格式无效");
        }
        try {
            String json = new String(Base64.getUrlDecoder().decode(pad(parts[1])), StandardCharsets.UTF_8);
            JsonNode claims = mapper.readTree(json);
            String u = claims.path("preferred_username").asText(null);
            if (u == null || u.isBlank()) {
                u = claims.path("email").asText(null);
            }
            if (u == null || u.isBlank()) {
                u = claims.path("sub").asText(null);
            }
            if (u == null || u.isBlank()) {
                throw new IllegalStateException("id_token 无用户名声明");
            }
            return u.trim();
        } catch (Exception e) {
            throw new IllegalStateException("解析 id_token 失败", e);
        }
    }

    private static String pad(String b64) {
        int mod = b64.length() % 4;
        if (mod == 0) {
            return b64;
        }
        return b64 + "=".repeat(4 - mod);
    }

    private static String enc(String v) {
        return URLEncoder.encode(v == null ? "" : v, StandardCharsets.UTF_8);
    }
}
