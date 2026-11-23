package com.dbops.security;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 最小 HS256 JWT 实现，与 Node jsonwebtoken 互通（同一个 JWT_SECRET 签发的 token 两边都能验）。
 * 仅接受 alg=HS256，拒绝 alg=none 等降级攻击；校验 exp/nbf。
 */
public final class JwtUtil {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Base64.Encoder B64 = Base64.getUrlEncoder().withoutPadding();
    private static final Base64.Decoder B64D = Base64.getUrlDecoder();
    private static final String HEADER = B64.encodeToString("{\"alg\":\"HS256\",\"typ\":\"JWT\"}".getBytes(StandardCharsets.UTF_8));
    private static final Pattern SPAN = Pattern.compile("^\\s*(\\d+(?:\\.\\d+)?)\\s*(ms|s|sec|secs|m|min|mins|h|hr|hrs|d|day|days|w|week|weeks)?\\s*$",
            Pattern.CASE_INSENSITIVE);

    private final byte[] secret;
    private final long expiresSec;

    public JwtUtil(String secret, String expires) {
        this.secret = secret.getBytes(StandardCharsets.UTF_8);
        this.expiresSec = parseSpanSeconds(expires, 8 * 3600);
    }

    public long getExpiresSec() {
        return expiresSec;
    }

    public String sign(Map<String, Object> claims) {
        long now = System.currentTimeMillis() / 1000;
        Map<String, Object> payload = new LinkedHashMap<>(claims);
        payload.put("iat", now);
        payload.put("exp", now + expiresSec);
        try {
            String body = B64.encodeToString(MAPPER.writeValueAsBytes(payload));
            String input = HEADER + "." + body;
            return input + "." + B64.encodeToString(hmac(input));
        } catch (Exception e) {
            throw new IllegalStateException("JWT 签发失败", e);
        }
    }

    /**
     * @return payload；签名/格式/过期不通过返回 null
     */
    public Map<String, Object> verify(String token) {
        if (token == null) {
            return null;
        }
        String[] parts = token.split("\\.");
        if (parts.length != 3) {
            return null;
        }
        try {
            Map<String, Object> header = MAPPER.readValue(B64D.decode(parts[0]), new TypeReference<Map<String, Object>>() {
            });
            if (!"HS256".equals(header.get("alg"))) {
                return null;
            }
            byte[] expected = hmac(parts[0] + "." + parts[1]);
            byte[] actual = B64D.decode(parts[2]);
            if (!MessageDigest.isEqual(expected, actual)) {
                return null;
            }
            Map<String, Object> payload = MAPPER.readValue(B64D.decode(parts[1]), new TypeReference<Map<String, Object>>() {
            });
            long now = System.currentTimeMillis() / 1000;
            Object exp = payload.get("exp");
            if (exp instanceof Number n && now >= n.longValue()) {
                return null;
            }
            Object nbf = payload.get("nbf");
            if (nbf instanceof Number n && now < n.longValue()) {
                return null;
            }
            return payload;
        } catch (Exception e) {
            return null;
        }
    }

    /** 网关转发给 Node 时，对“token + 网关确认的角色”签名（Node 用同一 JWT 密钥校验后采用该角色） */
    public String gatewaySign(String token, String role) {
        try {
            return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(hmac("gw|" + token + "|" + role));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private byte[] hmac(String input) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(secret, "HmacSHA256"));
        return mac.doFinal(input.getBytes(StandardCharsets.US_ASCII));
    }

    /** "8h" / "30m" / "7d" / "3600"（纯数字按秒） */
    static long parseSpanSeconds(String s, long def) {
        if (s == null || s.isBlank()) {
            return def;
        }
        Matcher m = SPAN.matcher(s);
        if (!m.matches()) {
            return def;
        }
        double v = Double.parseDouble(m.group(1));
        String unit = m.group(2) == null ? "s" : m.group(2).toLowerCase();
        double sec = switch (unit) {
            case "ms" -> v / 1000;
            case "m", "min", "mins" -> v * 60;
            case "h", "hr", "hrs" -> v * 3600;
            case "d", "day", "days" -> v * 86400;
            case "w", "week", "weeks" -> v * 7 * 86400;
            default -> v;
        };
        return Math.max(60, (long) sec);
    }
}
