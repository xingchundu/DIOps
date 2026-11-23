package com.dbops.license;

import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.Base64;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 授权：验签、机器码、到期 / 宽限 / 续期 / 时间回拨判定 */
class LicenseCodecTest {

    static long ms(String ts) {
        return LocalDateTime.parse(ts, LicenseCodec.TS).atZone(LicenseCodec.ZONE).toInstant().toEpochMilli();
    }

    static LicenseCodec.License lic(String id, String nb, String exp) {
        return new LicenseCodec.License(id, "客户", "MONTH", LocalDate.parse(nb.substring(0, 10)), LocalDateTime.parse(nb, LicenseCodec.TS),
                LocalDateTime.parse(exp, LicenseCodec.TS), "6B34-C24F-CE17-2F1A", null, "");
    }

    /** 签发工具（tools/license/LicenseTool.java）签出的文件，用打包的公钥验签：两边 canonical 与机器码算法一致 */
    @Test
    void toolIssuedFileVerifiesWithBundledPublicKey() throws Exception {
        // [fix] 该夹具由 tools/license/LicenseTool.java 使用「不随工程分发的私钥」签发，
        // 发布压缩包中不含此文件。缺夹具时跳过本用例，而不是把资源缺失误报为验签逻辑缺陷；
        // 完整仓库 / CI 中放入 unittest.lic 后，本用例会自动恢复完整校验。
        Path licFile = Path.of("src/test/resources/license/unittest.lic");
        Assumptions.assumeTrue(Files.exists(licFile),
                "缺少签发工具生成的测试授权文件 unittest.lic（需私钥签发，不随发布包分发）");
        String pub = Files.readString(Path.of("src/main/resources/license/public.key"));
        String content = Files.readString(licFile, StandardCharsets.UTF_8);
        LicenseCodec.License l = LicenseCodec.parse(content);
        assertEquals("单元测试客户", l.customer());
        assertTrue(LicenseCodec.verify(l, LicenseCodec.publicKey(pub)));
        assertEquals(l.machineCode(), LicenseCodec.machineCode("1234567890"));
        // 改到期时间 → 验签失败
        LicenseCodec.License forged = LicenseCodec.parse(content.replace("2026-12-10 23:59:59", "2036-12-10 23:59:59"));
        assertFalse(LicenseCodec.verify(forged, LicenseCodec.publicKey(pub)));
    }

    @Test
    void signAndVerifyWithOtherKeyFails() throws Exception {
        KeyPair a = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
        KeyPair b = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
        LicenseCodec.License l = lic("L1", "2026-11-10 00:00:00", "2027-11-10 23:59:59");
        Signature s = Signature.getInstance("Ed25519");
        s.initSign(a.getPrivate());
        s.update(LicenseCodec.canonical(l).getBytes(StandardCharsets.UTF_8));
        String sig = Base64.getEncoder().encodeToString(s.sign());
        LicenseCodec.License signed = new LicenseCodec.License(l.licenseId(), l.customer(), l.type(), l.issuedAt(), l.notBefore(), l.expiresAt(),
                l.machineCode(), l.maxInstances(), sig);
        assertTrue(LicenseCodec.verify(signed, a.getPublic()));
        assertFalse(LicenseCodec.verify(signed, b.getPublic()));   // 自签公钥替换不了
    }

    @Test
    void parseRejectsBadInput() {
        for (String bad : new String[]{"", "not json", "{\"licenseId\":\"x\"}", "{\"licenseId\":\"x\",\"customer\":\"c\",\"type\":\"FOREVER\",\"issuedAt\":\"2026-01-01\","
                + "\"notBefore\":\"2026-01-01 00:00:00\",\"expiresAt\":\"2027-01-01 23:59:59\",\"machineCode\":\"A\",\"signature\":\"s\"}"}) {
            try {
                LicenseCodec.parse(bad);
                throw new AssertionError("应拒绝：" + bad);
            } catch (IllegalArgumentException expected) {
                // ok
            }
        }
    }

    @Test
    void validExpiringExpiredStopped() {
        List<LicenseCodec.License> one = List.of(lic("L1", "2026-11-10 00:00:00", "2026-12-10 23:59:59"));
        LicenseCodec.Status v = LicenseCodec.evaluate(one, ms("2026-11-11 10:00:00"), false);
        assertEquals(LicenseCodec.State.VALID, v.state());
        assertTrue(v.loginAllowed() && v.backgroundAllowed());

        LicenseCodec.Status w = LicenseCodec.evaluate(one, ms("2026-12-01 10:00:00"), false);
        assertEquals(LicenseCodec.State.EXPIRING, w.state());
        assertEquals(9L, w.daysLeft());

        assertEquals(LicenseCodec.State.EXPIRING, LicenseCodec.evaluate(one, ms("2026-12-10 23:59:00"), false).state());

        LicenseCodec.Status e = LicenseCodec.evaluate(one, ms("2026-12-11 00:00:01"), false);
        assertEquals(LicenseCodec.State.EXPIRED, e.state());
        assertFalse(e.loginAllowed());
        assertTrue(e.backgroundAllowed());   // 宽限 7 天：采集告警继续

        assertEquals(LicenseCodec.State.EXPIRED, LicenseCodec.evaluate(one, ms("2026-12-17 23:59:00"), false).state());
        LicenseCodec.Status st = LicenseCodec.evaluate(one, ms("2026-12-18 00:00:00"), false);
        assertEquals(LicenseCodec.State.STOPPED, st.state());
        assertFalse(st.loginAllowed() || st.backgroundAllowed());
    }

    @Test
    void renewalChainsAndNoneAndTampered() {
        List<LicenseCodec.License> chain = List.of(lic("L1", "2026-11-10 00:00:00", "2026-12-10 23:59:59"),
                lic("L2", "2026-12-11 00:00:00", "2027-12-11 23:59:59"));
        LicenseCodec.Status s = LicenseCodec.evaluate(chain, ms("2026-12-05 00:00:00"), false);
        assertEquals(LicenseCodec.State.VALID, s.state());   // 已导入续期授权，不再提醒
        assertEquals(LocalDateTime.parse("2027-12-11 23:59:59", LicenseCodec.TS), s.effectiveExpiry());
        assertEquals(LicenseCodec.State.VALID, LicenseCodec.evaluate(chain, ms("2026-12-11 08:00:00"), false).state());

        LicenseCodec.Status none = LicenseCodec.evaluate(List.of(), ms("2026-11-10 00:00:00"), false);
        assertEquals(LicenseCodec.State.NONE, none.state());
        assertFalse(none.loginAllowed() || none.backgroundAllowed());

        LicenseCodec.Status future = LicenseCodec.evaluate(List.of(lic("L3", "2027-01-01 00:00:00", "2027-02-01 23:59:59")), ms("2026-11-10 00:00:00"), false);
        assertEquals(LicenseCodec.State.NONE, future.state());

        LicenseCodec.Status t = LicenseCodec.evaluate(chain, ms("2026-11-20 00:00:00"), true);
        assertEquals(LicenseCodec.State.CLOCK_TAMPERED, t.state());
        assertFalse(t.loginAllowed());
    }
}
