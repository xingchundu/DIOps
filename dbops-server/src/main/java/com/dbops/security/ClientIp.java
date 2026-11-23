package com.dbops.security;

import jakarta.servlet.http.HttpServletRequest;

/**
 * 客户端 IP：默认取 TCP 对端地址；TRUST_PROXY=1 时取 X-Forwarded-For 最右侧（最近一跳代理写入的）地址，
 * 避免直接信任客户端可伪造的最左值。
 */
public final class ClientIp {

    private ClientIp() {
    }

    public static String of(HttpServletRequest req, boolean trustProxy) {
        String ip = req.getRemoteAddr();
        if (trustProxy) {
            String xff = req.getHeader("X-Forwarded-For");
            if (xff != null && !xff.isBlank()) {
                String[] parts = xff.split(",");
                ip = parts[parts.length - 1].trim();
            }
        }
        if (ip == null) {
            return "";
        }
        ip = ip.replaceFirst("^::ffff:", "");
        return ip.length() > 128 ? ip.substring(0, 128) : ip;
    }
}
