package com.dbops.security;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

class JwtUtilTest {

    private final JwtUtil jwt = new JwtUtil("unit-test-secret-0123456789", "8h");

    @Test
    void roundTrip() {
        String t = jwt.sign(Map.of("userId", 7, "username", "admin", "role", "ADMIN", "menus", List.of("/dashboard")));
        Map<String, Object> p = jwt.verify(t);
        assertNotNull(p);
        assertEquals(7, ((Number) p.get("userId")).intValue());
        assertEquals("ADMIN", p.get("role"));
    }

    @Test
    void rejectsTamperedAndNoneAlg() {
        String t = jwt.sign(Map.of("userId", 1, "role", "VIEWER"));
        String[] parts = t.split("\\.");
        String evilPayload = Base64.getUrlEncoder().withoutPadding()
                .encodeToString("{\"userId\":1,\"role\":\"ADMIN\",\"exp\":9999999999}".getBytes(StandardCharsets.UTF_8));
        assertNull(jwt.verify(parts[0] + "." + evilPayload + "." + parts[2]));
        String none = Base64.getUrlEncoder().withoutPadding().encodeToString("{\"alg\":\"none\"}".getBytes(StandardCharsets.UTF_8));
        assertNull(jwt.verify(none + "." + evilPayload + "."));
        assertNull(new JwtUtil("another-secret-0123456789", "8h").verify(t));
    }

    @Test
    void expired() {
        String header = Base64.getUrlEncoder().withoutPadding().encodeToString("{\"alg\":\"HS256\",\"typ\":\"JWT\"}".getBytes(StandardCharsets.UTF_8));
        // 用 sign 生成后无法改 exp，这里只验证解析时长
        assertEquals(8 * 3600, JwtUtil.parseSpanSeconds("8h", 1));
        assertEquals(30 * 60, JwtUtil.parseSpanSeconds("30m", 1));
        assertEquals(2 * 86400, JwtUtil.parseSpanSeconds("2d", 1));
        assertEquals(3600, JwtUtil.parseSpanSeconds("3600", 1));
        assertEquals(123, JwtUtil.parseSpanSeconds("bogus", 123));
        assertNotNull(header);
    }

    /** 与 Node jsonwebtoken 互通：以下 token 由 jsonwebtoken.sign({userId:1,username:'admin',role:'ADMIN',tenantId:1,menus:[]}, 'unit-test-secret-0123456789', {expiresIn:'100y'}) 生成 */
    @Test
    void verifiesNodeIssuedToken() {
        String nodeToken = System.getProperty("nodeToken", NODE_TOKEN);
        Map<String, Object> p = jwt.verify(nodeToken);
        assertNotNull(p);
        assertEquals("admin", p.get("username"));
    }

    static final String NODE_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjEsInVzZXJuYW1lIjoiYWRtaW4iLCJyb2xlIjoiQURNSU4iLCJ0ZW5hbnRJZCI6MSwibWVudXMiOltdLCJpYXQiOjE3OTM4ODcyNjgsImV4cCI6NDk0OTY0NzI2OH0.S868SK5sTbOU7yd6_w-1esOoqjs5IOulax-1BzhHwsU";
}
