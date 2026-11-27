package com.dbops.license;

import com.dbops.common.BizException;
import com.dbops.common.Db;
import com.dbops.common.Values;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 授权状态：每分钟按平台库时间重新判定一次，结果缓存在内存，登录 / 接口 / 后台任务只读缓存。
 * <ul>
 *   <li>公钥打包在 jar 内（resources/license/public.key），不提供配置覆盖，避免被替换成自签公钥</li>
 *   <li>机器码绑定平台库 DBID（SYS_CONTEXT('USERENV','DBID')，不需要额外权限）</li>
 *   <li>时间取平台库 SYSTIMESTAMP；SYS_LICENSE_STATE 记录见过的最晚时间（带 HMAC），比它早 1 小时以上判定为时间回拨</li>
 * </ul>
 */
@Service
public class LicenseService {

    private static final Logger log = LoggerFactory.getLogger(LicenseService.class);

    private final Db db;
    private final com.dbops.alert.AlertPolicyService policies;
    private final PublicKey publicKey;
    private final byte[] publicKeyBytes;
    private volatile LicenseCodec.Status status =
            new LicenseCodec.Status(LicenseCodec.State.UNKNOWN, "授权状态检查中，请稍后重试", null, null, null, false, true);
    private volatile String machineCode;
    private volatile long lastOkAt;
    private volatile List<String> rejected = List.of();

    public LicenseService(Db db, com.dbops.alert.AlertPolicyService policies) {
        this.db = db;
        this.policies = policies;
        String b64;
        try (InputStream in = LicenseService.class.getResourceAsStream("/license/public.key")) {
            if (in == null) {
                throw new IllegalStateException("not found");
            }
            b64 = new String(in.readAllBytes(), StandardCharsets.UTF_8).trim();
        } catch (Exception e) {
            throw new IllegalStateException("缺少授权公钥 resources/license/public.key", e);
        }
        this.publicKey = LicenseCodec.publicKey(b64);
        this.publicKeyBytes = b64.getBytes(StandardCharsets.UTF_8);
    }

    @PostConstruct
    void init() {
        refresh();
    }

    @Scheduled(fixedDelay = 60_000L, initialDelay = 20_000L)
    public void scheduledRefresh() {
        refresh();
        remind();
    }

    public static final String ALERT_RULE = "授权到期提醒";

    /** 到期前 7 天起、以及宽限期内，每天在告警中心生成一条提醒（走告警策略推送） */
    void remind() {
        LicenseCodec.Status s = status;
        boolean soon = s.state() == LicenseCodec.State.EXPIRING && s.daysLeft() != null && s.daysLeft() <= 7;
        boolean grace = s.state() == LicenseCodec.State.EXPIRED;
        if (!soon && !grace) {
            return;
        }
        try {
            if (db.one("SELECT 1 X FROM ALERT_RECORD WHERE RULE_NAME = ? AND TRIGGER_TIME >= TRUNC(SYSDATE) FETCH FIRST 1 ROWS ONLY", ALERT_RULE) != null) {
                return;
            }
            Long id = db.insertReturningId("INSERT INTO ALERT_RECORD (RULE_NAME, INSTANCE_NAME, SEVERITY, CONTENT, STATUS, TRIGGER_TIME) "
                    + "VALUES (?, '平台授权', ?, ?, 'OPEN', SYSTIMESTAMP)", "ALERT_ID", ALERT_RULE, grace ? "P1" : "P2",
                    s.message() + "。机器码 " + machineCode);
            if (id != null) {
                policies.applyForNewAlert(id);
            }
        } catch (Exception e) {
            log.warn("[license] remind failed: {}", e.getMessage());
        }
    }

    public LicenseCodec.Status status() {
        return status;
    }

    public boolean loginAllowed() {
        return status.loginAllowed();
    }

    /** 采集、告警等后台任务是否继续（到期后宽限 7 天） */
    public boolean backgroundAllowed() {
        return status.backgroundAllowed();
    }

    public String machineCode() {
        return machineCode;
    }

    public synchronized LicenseCodec.Status refresh() {
        try {
            Map<String, Object> r = db.one("SELECT SYS_CONTEXT('USERENV', 'DBID') DBID, "
                    + "ROUND((CAST(SYS_EXTRACT_UTC(SYSTIMESTAMP) AS DATE) - DATE '1970-01-01') * 86400000) NOW_MS FROM DUAL");
            String dbid = Values.str(r.get("DBID"), "");
            long now = Values.toLong(r.get("NOW_MS"));
            machineCode = LicenseCodec.machineCode(dbid);
            boolean tampered = clockTampered(now);
            List<LicenseCodec.License> ok = new ArrayList<>();
            List<String> bad = new ArrayList<>();
            List<Map<String, Object>> rows;
            try {
                rows = db.query("SELECT LICENSE_ID, CONTENT FROM SYS_LICENSE WHERE STATUS = 'ACTIVE'");
            } catch (Exception e) {
                if (Db.isMissingTable(e)) {
                    status = new LicenseCodec.Status(LicenseCodec.State.NONE, "授权表未初始化：请在平台库执行 sql/init.sql（新装）或 sql/license_tables.sql 后导入授权",
                            null, null, null, false, false);
                    return status;
                }
                throw e;
            }
            for (Map<String, Object> row : rows) {
                String reason = check(Values.str(row.get("CONTENT"), ""), ok);
                if (reason != null) {
                    bad.add(row.get("LICENSE_ID") + "：" + reason);
                }
            }
            rejected = bad;
            LicenseCodec.Status s = LicenseCodec.evaluate(ok, now, tampered);
            if (s.state() != status.state()) {
                log.info("[license] {} {}", s.state(), s.message());
            }
            status = s;
            lastOkAt = System.currentTimeMillis();
        } catch (Exception e) {
            // 平台库短暂不可用：沿用上次结果；超过 10 分钟仍不可用则判定为 UNKNOWN（此时登录本身也无法完成）
            log.warn("[license] refresh failed: {}", e.getMessage());
            if (System.currentTimeMillis() - lastOkAt > 10 * 60_000L) {
                status = new LicenseCodec.Status(LicenseCodec.State.UNKNOWN, "平台库不可用，无法校验授权", null, null, null, false, status.backgroundAllowed());
            }
        }
        return status;
    }

    /** 验签 + 机器码；通过则加入 ok，返回 null，否则返回原因 */
    private String check(String content, List<LicenseCodec.License> ok) {
        LicenseCodec.License l;
        try {
            l = LicenseCodec.parse(content);
        } catch (IllegalArgumentException e) {
            return e.getMessage();
        }
        if (!LicenseCodec.verify(l, publicKey)) {
            return "签名校验失败（文件被修改或不是本产品签发）";
        }
        if (!l.machineCode().equalsIgnoreCase(machineCode)) {
            return "机器码不符（授权机器码 " + l.machineCode() + "，本机 " + machineCode + "）";
        }
        ok.add(l);
        return null;
    }

    // ------------------------------------------------------------------ 时间回拨检测

    private boolean clockTampered(long now) {
        try {
            Map<String, Object> st = db.one("SELECT LAST_SEEN_MS, MAC FROM SYS_LICENSE_STATE WHERE ID = 1");
            if (st == null) {
                db.update("INSERT INTO SYS_LICENSE_STATE (ID, LAST_SEEN_MS, MAC) VALUES (1, ?, ?)", now, mac(now));
                return false;
            }
            long last = Values.toLong(st.get("LAST_SEEN_MS"));
            String stored = Values.str(st.get("MAC"), "");
            if (!mac(last).equals(stored)) {
                if (secretMaterial() != null && legacyMac(last).equals(stored)) {
                    // 升级前用旧算法（仅公钥+机器码）签的记录：校验通过后改用带服务端密钥的新算法重签
                    db.update("UPDATE SYS_LICENSE_STATE SET MAC = ? WHERE ID = 1", mac(last));
                } else {
                    log.warn("[license] SYS_LICENSE_STATE 校验失败（记录被修改，或 DBOPS_SECRET_KEY 未加载/已更换）");
                    return true;
                }
            }
            if (now < last - LicenseCodec.CLOCK_TOLERANCE_MS) {
                return true;
            }
            if (now > last) {
                db.update("UPDATE SYS_LICENSE_STATE SET LAST_SEEN_MS = ?, MAC = ? WHERE ID = 1", now, mac(now));
            }
            return false;
        } catch (Exception e) {
            if (Db.isMissingTable(e)) {
                return false;
            }
            throw e;
        }
    }

    /**
     * 防回拨记录的 HMAC 密钥。原来只由公钥 + 机器码推导——两者都是公开信息，任何人都能重算 MAC 伪造记录。
     * 现在混入 DBOPS_SECRET_KEY（未配置时退回 JWT_SECRET；都没有时保持旧算法）。
     * 启动脚本把 .env 放进 System properties，不一定导出到进程环境变量，两边都要看，否则每次都会被误判为时间回拨。
     */
    static String secretMaterial() {
        String k = configured("DBOPS_SECRET_KEY");
        if (k == null) {
            k = configured("JWT_SECRET");
        }
        return k;
    }

    private static String configured(String key) {
        String v = System.getenv(key);
        if (v == null || v.isBlank()) {
            v = System.getProperty(key);
        }
        return v == null || v.isBlank() ? null : v.trim();
    }

    String legacyMac(long v) {
        return macWith(v, "");
    }

    String mac(long v) {
        String sec = secretMaterial();
        return macWith(v, sec == null ? "" : "|" + sec);
    }

    private String macWith(long v, String extra) {
        try {
            byte[] key = MessageDigest.getInstance("SHA-256").digest((new String(publicKeyBytes, StandardCharsets.UTF_8) + "|" + machineCode + extra)
                    .getBytes(StandardCharsets.UTF_8));
            Mac m = Mac.getInstance("HmacSHA256");
            m.init(new SecretKeySpec(key, "HmacSHA256"));
            return HexFormat.of().formatHex(m.doFinal(Long.toString(v).getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    // ------------------------------------------------------------------ 导入

    /** 导入授权：验签、机器码、未过期；同一 licenseId 重复导入视为成功 */
    public synchronized Map<String, Object> activate(String content, Long userId, String username) {
        if (machineCode == null) {
            refresh();
        }
        if (machineCode == null) {
            throw new BizException(503, "平台库不可用，无法导入授权");
        }
        LicenseCodec.License l;
        try {
            l = LicenseCodec.parse(content);
        } catch (IllegalArgumentException e) {
            throw new BizException(400, e.getMessage());
        }
        if (!LicenseCodec.verify(l, publicKey)) {
            throw new BizException(400, "签名校验失败：授权文件被修改，或不是本产品签发的授权");
        }
        if (!l.machineCode().equalsIgnoreCase(machineCode)) {
            throw new BizException(400, "机器码不符：授权文件对应 " + l.machineCode() + "，本平台机器码为 " + machineCode);
        }
        Map<String, Object> t = db.one("SELECT ROUND((CAST(SYS_EXTRACT_UTC(SYSTIMESTAMP) AS DATE) - DATE '1970-01-01') * 86400000) NOW_MS FROM DUAL");
        if (l.expiresAt().isBefore(LicenseCodec.toLocal(Values.toLong(t.get("NOW_MS"))))) {
            throw new BizException(400, "该授权已于 " + LicenseCodec.TS.format(l.expiresAt()) + " 到期，请联系供应商获取新授权");
        }
        try {
            if (db.one("SELECT 1 X FROM SYS_LICENSE WHERE LICENSE_ID = ?", l.licenseId()) == null) {
                db.update("INSERT INTO SYS_LICENSE (LICENSE_ID, CUSTOMER, LICENSE_TYPE, ISSUED_AT, NOT_BEFORE, EXPIRES_AT, MACHINE_CODE, MAX_INSTANCES, "
                                + "CONTENT, STATUS, ACTIVATED_AT, ACTIVATED_BY) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', SYSTIMESTAMP, ?)",
                        l.licenseId(), l.customer(), l.type(), java.sql.Date.valueOf(l.issuedAt()), Timestamp.valueOf(l.notBefore()),
                        Timestamp.valueOf(l.expiresAt()), l.machineCode(), l.maxInstances(), content.trim(), username);
            } else {
                db.update("UPDATE SYS_LICENSE SET STATUS = 'ACTIVE' WHERE LICENSE_ID = ?", l.licenseId());
            }
        } catch (Exception e) {
            if (Db.isMissingTable(e)) {
                throw new BizException(500, "授权表未初始化：请在平台库执行 sql/init.sql（新装）或 sql/license_tables.sql");
            }
            throw e;
        }
        log.info("[license] activated {} ({} {} ~ {}) by {}", l.licenseId(), l.customer(), l.notBefore(), l.expiresAt(), username);
        refresh();
        return publicStatus();
    }

    // ------------------------------------------------------------------ 输出

    /** 不需要登录即可查看：登录页据此提示并显示机器码 */
    public Map<String, Object> publicStatus() {
        LicenseCodec.Status s = status;
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("state", s.state().name());
        m.put("message", s.message());
        m.put("loginAllowed", s.loginAllowed());
        m.put("backgroundAllowed", s.backgroundAllowed());
        m.put("machineCode", machineCode);
        m.put("expiresAt", s.effectiveExpiry() == null ? null : LicenseCodec.TS.format(s.effectiveExpiry()));
        m.put("daysLeft", s.daysLeft());
        m.put("type", s.license() == null ? null : s.license().type());
        return m;
    }

    /** 登录后查看：客户、实例上限、历史授权 */
    public Map<String, Object> info() {
        Map<String, Object> m = publicStatus();
        LicenseCodec.License l = status.license();
        m.put("customer", l == null ? null : l.customer());
        m.put("licenseId", l == null ? null : l.licenseId());
        m.put("maxInstances", l == null ? null : l.maxInstances());
        m.put("graceDays", LicenseCodec.GRACE_DAYS);
        m.put("rejected", rejected);
        try {
            m.put("history", db.query("SELECT LICENSE_ID, CUSTOMER, LICENSE_TYPE, NOT_BEFORE, EXPIRES_AT, MAX_INSTANCES, STATUS, ACTIVATED_AT, ACTIVATED_BY "
                    + "FROM SYS_LICENSE ORDER BY ACTIVATED_AT DESC"));
        } catch (Exception e) {
            m.put("history", List.of());
        }
        return m;
    }

    /** 纳管实例数上限（当前授权未限制时为 null） */
    public Integer maxInstances() {
        LicenseCodec.License l = status.license();
        return l == null || !status.loginAllowed() ? null : l.maxInstances();
    }
}
