package com.dbops.security;

import com.dbops.common.BizException;

import java.util.Arrays;
import java.util.List;

/**
 * 当前登录用户（来自 JWT，角色以数据库最新值为准）。
 */
public record CurrentUser(long userId, String username, String role, Long tenantId, List<String> menus) {

    public static final String REQUEST_ATTR = "dbops.currentUser";

    public boolean hasRole(String... roles) {
        return role != null && Arrays.asList(roles).contains(role);
    }

    public boolean isAdmin() {
        return "ADMIN".equals(role);
    }

    /** 对应 Node requireRole(...)：不满足时抛 403 */
    public void require(String... roles) {
        if (!hasRole(roles)) {
            throw BizException.forbidden();
        }
    }
}
