package com.dbops.monitor;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class SecretsTest {

    @Test
    void aesGcmRoundTripAndNodeCompatibility() {
        String prev = System.getProperty("DBOPS_SECRET_KEY");
        System.setProperty("DBOPS_SECRET_KEY", "unit-test-key");
        try {
            String plain = "P@ss中文;1";
            String a = Secrets.encode(plain);
            String b = Secrets.encode(plain);
            assertTrue(a.startsWith(Secrets.PREFIX));
            assertNotEquals(a, b);                       // 随机 IV
            assertEquals(plain, Secrets.decode(a));
            assertFalse(Secrets.isLegacy(a));
            // Node 侧 backend/src/utils/secrets.js 用同一密钥加密的结果，Java 必须能解开（两端共用一份密文）
            assertEquals(plain, Secrets.decode("AESGCM:v1:MTHPZTZ1zORDbhZQx/q6aS8+m+Pobljhi2ZSD7YD9wNB+n2B2/Iwzg=="));
            // 历史 Base64 仍可读取，并被识别为待迁移
            assertEquals("oldpwd", Secrets.decode("b2xkcHdk"));
            assertTrue(Secrets.isLegacy("b2xkcHdk"));
        } finally {
            if (prev == null) {
                System.clearProperty("DBOPS_SECRET_KEY");
            } else {
                System.setProperty("DBOPS_SECRET_KEY", prev);
            }
        }
    }
}
