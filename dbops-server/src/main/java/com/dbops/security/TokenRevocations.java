package com.dbops.security;

import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 已退出的 token（主动退出 / 无操作超时退出）在过期前不可再用。
 * <p>
 * [fix] 原来退出只记审计日志，token 在 8 小时有效期内仍可继续调用接口（被复制的 token、未关闭的其它标签页）。
 * 内存实现：单节点足够；多节点部署时退出只在收到请求的节点生效，可替换为共享存储。
 */
@Component
public class TokenRevocations {

    private final Map<String, Long> revoked = new ConcurrentHashMap<>();

    public void revoke(String token, long expEpochSec) {
        if (token == null || token.isBlank()) {
            return;
        }
        long exp = expEpochSec > 0 ? expEpochSec : System.currentTimeMillis() / 1000 + 24 * 3600;
        revoked.put(hash(token), exp);
        if (revoked.size() > 1000) {
            cleanup();
        }
    }

    public boolean isRevoked(String token) {
        if (token == null || revoked.isEmpty()) {
            return false;
        }
        Long exp = revoked.get(hash(token));
        if (exp == null) {
            return false;
        }
        if (exp < System.currentTimeMillis() / 1000) {
            revoked.remove(hash(token));
            return false;
        }
        return true;
    }

    /** 从 Authorization 头取 token */
    public static String bearer(String header) {
        return header != null && header.startsWith("Bearer ") ? header.substring(7).trim() : null;
    }

    void cleanup() {
        long now = System.currentTimeMillis() / 1000;
        revoked.entrySet().removeIf(e -> e.getValue() < now);
    }

    static String hash(String token) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 16; i++) {
                sb.append(String.format("%02x", d[i]));
            }
            return sb.toString();
        } catch (Exception e) {
            return token;
        }
    }
}
