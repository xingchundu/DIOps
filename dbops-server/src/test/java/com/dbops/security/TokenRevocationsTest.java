package com.dbops.security;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class TokenRevocationsTest {

    @Test
    void revokedUntilExpiry() {
        TokenRevocations r = new TokenRevocations();
        long now = System.currentTimeMillis() / 1000;
        r.revoke("aaa", now + 3600);
        r.revoke("old", now - 10);
        assertTrue(r.isRevoked("aaa"));
        assertFalse(r.isRevoked("bbb"));
        assertFalse(r.isRevoked("old"));      // 已过期的 token 本来就无效，不必占内存
        assertFalse(r.isRevoked(null));
        assertEquals("tok", TokenRevocations.bearer("Bearer tok"));
        assertEquals(null, TokenRevocations.bearer("Basic x"));
    }
}
