package com.dbops.license;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;

/**
 * 授权文件编解码与判定（纯函数，便于单测）。
 * <pre>
 * 授权文件：JSON，字段见 {@link License}；signature = Ed25519(私钥, canonical(授权))，Base64。
 * canonical：固定前缀 + 各字段按固定顺序以换行连接（JSON 的空格、字段顺序不影响验签）。
 * 机器码：SHA-256("DIOPS|DBID|" + 平台库 DBID) 前 16 位十六进制，形如 8F3A-1C2D-…；
 *         只绑定平台库，迁移应用服务器不需要重签，换平台库才需要。
 * 时间：一律按北京时间（Asia/Shanghai）解释，到期时间含当天 23:59:59。
 * </pre>
 * 签发工具 tools/license/LicenseTool.java 使用完全相同的 canonical 与机器码算法，两处改动必须同步。
 */
public final class LicenseCodec {

    public static final String PREFIX = "DIOPS-LICENSE-V1";
    public static final ZoneId ZONE = ZoneId.of("Asia/Shanghai");
    public static final DateTimeFormatter TS = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss", Locale.ROOT);
    /** 到期后登录与接口立即停止；采集与告警再运行的天数 */
    public static final int GRACE_DAYS = 7;
    /** 到期前开始提醒的天数 */
    public static final int WARN_DAYS = 15;
    /** 数据库时间比“见过的最晚时间”早这么多，判定为时间被回拨 */
    public static final long CLOCK_TOLERANCE_MS = 3600_000L;

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private LicenseCodec() {
    }

    public record License(String licenseId, String customer, String type, LocalDate issuedAt, LocalDateTime notBefore,
                          LocalDateTime expiresAt, String machineCode, Integer maxInstances, String signature) {
    }

    public enum State {
        /** 有效 */
        VALID,
        /** 有效，WARN_DAYS 天内到期 */
        EXPIRING,
        /** 已到期，宽限期内：不能登录，采集告警继续 */
        EXPIRED,
        /** 到期超过宽限期：采集告警也停止 */
        STOPPED,
        /** 没有导入授权（或授权都还没到生效时间） */
        NONE,
        /** 检测到系统时间被回拨 */
        CLOCK_TAMPERED,
        /** 平台库不可用，无法判定 */
        UNKNOWN
    }

    public record Status(State state, String message, License license, LocalDateTime effectiveExpiry, Long daysLeft,
                         boolean loginAllowed, boolean backgroundAllowed) {
    }

    // ------------------------------------------------------------------ 编码

    public static String canonical(License l) {
        return String.join("\n", PREFIX, nz(l.licenseId()), nz(l.customer()), nz(l.type()),
                l.issuedAt() == null ? "" : l.issuedAt().toString(),
                l.notBefore() == null ? "" : TS.format(l.notBefore()),
                l.expiresAt() == null ? "" : TS.format(l.expiresAt()),
                nz(l.machineCode()), l.maxInstances() == null ? "" : String.valueOf(l.maxInstances()));
    }

    private static String nz(String s) {
        return s == null ? "" : s.trim();
    }

    /** 解析授权文件内容（JSON）；格式不对抛 IllegalArgumentException，消息可直接展示 */
    public static License parse(String content) {
        if (content == null || content.isBlank()) {
            throw new IllegalArgumentException("授权内容为空");
        }
        JsonNode n;
        try {
            n = MAPPER.readTree(content.trim());
        } catch (Exception e) {
            throw new IllegalArgumentException("授权文件格式不正确（不是有效的 JSON）");
        }
        try {
            String type = text(n, "type").toUpperCase(Locale.ROOT);
            if (!List.of("MONTH", "YEAR", "TRIAL", "CUSTOM").contains(type)) {
                throw new IllegalArgumentException("未知的授权类型：" + type);
            }
            JsonNode mi = n.get("maxInstances");
            return new License(text(n, "licenseId"), text(n, "customer"), type, LocalDate.parse(text(n, "issuedAt")),
                    LocalDateTime.parse(text(n, "notBefore"), TS), LocalDateTime.parse(text(n, "expiresAt"), TS),
                    text(n, "machineCode").toUpperCase(Locale.ROOT),
                    mi == null || mi.isNull() || mi.asText().isBlank() ? null : mi.asInt(), text(n, "signature"));
        } catch (IllegalArgumentException e) {
            throw e;
        } catch (Exception e) {
            throw new IllegalArgumentException("授权文件字段不完整或日期格式不正确：" + e.getMessage());
        }
    }

    private static String text(JsonNode n, String f) {
        JsonNode v = n.get(f);
        if (v == null || v.isNull() || v.asText().isBlank()) {
            throw new IllegalArgumentException("授权文件缺少字段 " + f);
        }
        return v.asText().trim();
    }

    public static PublicKey publicKey(String base64X509) {
        try {
            byte[] der = Base64.getDecoder().decode(base64X509.replaceAll("\\s", ""));
            return KeyFactory.getInstance("Ed25519").generatePublic(new X509EncodedKeySpec(der));
        } catch (Exception e) {
            throw new IllegalStateException("授权公钥无效：" + e.getMessage(), e);
        }
    }

    public static boolean verify(License l, PublicKey key) {
        try {
            Signature s = Signature.getInstance("Ed25519");
            s.initVerify(key);
            s.update(canonical(l).getBytes(StandardCharsets.UTF_8));
            return s.verify(Base64.getDecoder().decode(l.signature()));
        } catch (Exception e) {
            return false;
        }
    }

    public static String machineCode(String dbid) {
        try {
            byte[] h = MessageDigest.getInstance("SHA-256").digest(("DIOPS|DBID|" + dbid.trim()).getBytes(StandardCharsets.UTF_8));
            String hex = HexFormat.of().withUpperCase().formatHex(h).substring(0, 16);
            return hex.substring(0, 4) + "-" + hex.substring(4, 8) + "-" + hex.substring(8, 12) + "-" + hex.substring(12, 16);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    // ------------------------------------------------------------------ 判定

    public static LocalDateTime toLocal(long epochMs) {
        return LocalDateTime.ofInstant(Instant.ofEpochMilli(epochMs), ZONE);
    }

    /**
     * @param licenses 已验签、机器码一致的授权（可多份：续期授权的生效时间接在旧授权到期之后）
     * @param nowMs    平台库时间
     */
    public static Status evaluate(List<License> licenses, long nowMs, boolean clockTampered) {
        if (clockTampered) {
            return new Status(State.CLOCK_TAMPERED, "检测到系统时间被回拨，授权暂不可用；请校正平台库服务器时间", null, null, null, false, false);
        }
        LocalDateTime now = toLocal(nowMs);
        List<License> sorted = new ArrayList<>(licenses);
        sorted.sort(Comparator.comparing(License::notBefore));
        License covering = null;
        for (License l : sorted) {
            if (!now.isBefore(l.notBefore()) && !now.isAfter(l.expiresAt())
                    && (covering == null || l.expiresAt().isAfter(covering.expiresAt()))) {
                covering = l;
            }
        }
        if (covering != null) {
            // 续期链：后一份的生效时间不晚于当前到期时间 + 1 天，就接上
            LocalDateTime exp = covering.expiresAt();
            boolean extended = true;
            while (extended) {
                extended = false;
                for (License l : sorted) {
                    if (l.expiresAt().isAfter(exp) && !l.notBefore().isAfter(exp.plusDays(1))) {
                        exp = l.expiresAt();
                        extended = true;
                    }
                }
            }
            long days = Math.max(0, java.time.Duration.between(now, exp).toHours() / 24);
            if (days < WARN_DAYS) {
                return new Status(State.EXPIRING, "授权将于 " + TS.format(exp) + " 到期（剩余 " + days + " 天），请及时续期", covering, exp, days, true, true);
            }
            return new Status(State.VALID, "授权有效，至 " + TS.format(exp), covering, exp, days, true, true);
        }
        License last = null;
        for (License l : sorted) {
            if (l.expiresAt().isBefore(now) && (last == null || l.expiresAt().isAfter(last.expiresAt()))) {
                last = l;
            }
        }
        if (last != null) {
            LocalDateTime stopAt = last.expiresAt().plusDays(GRACE_DAYS);
            if (now.isBefore(stopAt)) {
                return new Status(State.EXPIRED, "授权已于 " + TS.format(last.expiresAt()) + " 到期，无法登录；监控采集与告警将于 "
                        + TS.format(stopAt) + " 停止，请尽快导入新授权", last, last.expiresAt(), 0L, false, true);
            }
            return new Status(State.STOPPED, "授权已于 " + TS.format(last.expiresAt()) + " 到期，无法登录，监控采集与告警已停止；请导入新授权",
                    last, last.expiresAt(), 0L, false, false);
        }
        if (!sorted.isEmpty()) {
            return new Status(State.NONE, "授权尚未生效（生效时间 " + TS.format(sorted.get(0).notBefore()) + "）", sorted.get(0), null, null, false, false);
        }
        return new Status(State.NONE, "尚未导入授权，请将本机机器码发给供应商获取授权文件后导入", null, null, null, false, false);
    }
}
