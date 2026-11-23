package com.dbops.monitor;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;

/**
 * 被管库密码 / SSH 凭据加解密。
 * <pre>
 * 新格式：AESGCM:v1:&lt;base64(iv[12] || ciphertext || tag[16])&gt;，AES-256-GCM（与 Node utils/secrets.js 相同）
 * 旧格式：Base64（可带 ENCRYPTED: 前缀）—— 只读兼容；配置密钥后 SecretsMigrator 启动时把旧数据改写为新格式
 * 密钥：DBOPS_SECRET_KEY（环境变量或 .env），任意长度口令经 SHA-256 得到 32 字节密钥；启动脚本首次运行时自动生成
 * </pre>
 * 未配置密钥时：新数据退回旧格式保存并告警（只适合开发环境）；遇到新格式数据无法解密时抛错，而不是返回乱码。
 */
public final class Secrets {

    private static final Logger log = LoggerFactory.getLogger(Secrets.class);
    public static final String PREFIX = "AESGCM:v1:";
    private static final SecureRandom RANDOM = new SecureRandom();
    private static volatile boolean warned;

    private Secrets() {
    }

    static byte[] key() {
        String raw = System.getenv("DBOPS_SECRET_KEY");
        if (raw == null || raw.isBlank()) {
            raw = System.getProperty("DBOPS_SECRET_KEY");
        }
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            return MessageDigest.getInstance("SHA-256").digest(raw.trim().getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    public static boolean keyConfigured() {
        return key() != null;
    }

    public static boolean isLegacy(Object enc) {
        return enc != null && !String.valueOf(enc).isBlank() && !String.valueOf(enc).trim().startsWith(PREFIX);
    }

    public static String decode(Object enc) {
        if (enc == null) {
            return "";
        }
        String s = String.valueOf(enc).trim();
        if (s.isEmpty()) {
            return "";
        }
        if (s.startsWith(PREFIX)) {
            byte[] k = key();
            if (k == null) {
                throw new IllegalStateException("凭据已加密，但未配置 DBOPS_SECRET_KEY，无法解密");
            }
            try {
                byte[] all = Base64.getDecoder().decode(s.substring(PREFIX.length()));
                ByteBuffer bb = ByteBuffer.wrap(all);
                byte[] iv = new byte[12];
                bb.get(iv);
                byte[] ct = new byte[bb.remaining()];
                bb.get(ct);
                Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
                c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(k, "AES"), new GCMParameterSpec(128, iv));
                return new String(c.doFinal(ct), StandardCharsets.UTF_8);
            } catch (Exception e) {
                throw new IllegalStateException("凭据解密失败（DBOPS_SECRET_KEY 与加密时不一致？）", e);
            }
        }
        if (s.regionMatches(true, 0, "ENCRYPTED:", 0, 10)) {
            s = s.substring(10);
        }
        try {
            return new String(Base64.getMimeDecoder().decode(s), StandardCharsets.UTF_8);
        } catch (IllegalArgumentException e) {
            return s;   // 历史上直接存了明文
        }
    }

    public static String encode(String plain) {
        if (plain == null || plain.trim().isEmpty()) {
            return null;
        }
        byte[] k = key();
        if (k == null) {
            if (!warned) {
                warned = true;
                log.warn("[secrets] 未配置 DBOPS_SECRET_KEY，凭据仅做 Base64 编码保存（不安全，生产环境必须配置）");
            }
            return Base64.getEncoder().encodeToString(plain.getBytes(StandardCharsets.UTF_8));
        }
        try {
            byte[] iv = new byte[12];
            RANDOM.nextBytes(iv);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(k, "AES"), new GCMParameterSpec(128, iv));
            byte[] ct = c.doFinal(plain.getBytes(StandardCharsets.UTF_8));
            return PREFIX + Base64.getEncoder().encodeToString(ByteBuffer.allocate(iv.length + ct.length).put(iv).put(ct).array());
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
