package com.dbops.service;

import com.dbops.common.Db;
import com.dbops.common.R;
import com.dbops.common.Values;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 菜单权限（同 Node services/rbacService.js）
 */
@Service
public class RbacService {

    public static final List<String> FALLBACK_MENUS_ALL = List.of(
            "/dashboard", "/monitor", "/alerts", "/cmdb", "/cmdb/hosts",
            "/cmdb/clusters", "/automation", "/sql", "/sql-insight", "/sql-review", "/reports", "/ai",
            "/settings/profile", "/settings/users", "/settings/roles");

    private static final List<String> MIN_MENUS = List.of("/dashboard", "/settings/profile");

    private final Db db;
    private volatile Boolean ready;
    private volatile long readyCheckedAt;

    public RbacService(Db db) {
        this.db = db;
    }

    /**
     * [fix] Node 版把“表是否存在”永久缓存，首次判断为 false（如迁移脚本还没跑）后必须重启才生效；这里 5 分钟后重新检测。
     */
    public boolean tablesReady() {
        Boolean r = ready;
        if (r != null && (r || System.currentTimeMillis() - readyCheckedAt < 300_000)) {
            return r;
        }
        boolean ok;
        try {
            ok = db.count("SELECT COUNT(*) AS C FROM USER_TABLES WHERE TABLE_NAME IN ('SYS_ROLE','SYS_MENU','SYS_ROLE_MENU')") == 3;
        } catch (Exception e) {
            ok = false;
        }
        ready = ok;
        readyCheckedAt = System.currentTimeMillis();
        return ok;
    }

    public List<String> menuPathsForRole(String roleCode) {
        if (!tablesReady()) {
            return "ADMIN".equals(roleCode) ? new ArrayList<>(FALLBACK_MENUS_ALL) : new ArrayList<>(MIN_MENUS);
        }
        List<Map<String, Object>> rows;
        if ("ADMIN".equals(roleCode)) {
            rows = db.query("SELECT MENU_PATH FROM SYS_MENU ORDER BY SORT_ORDER, MENU_ID");
        } else {
            rows = db.query("SELECT m.MENU_PATH FROM SYS_MENU m "
                    + "INNER JOIN SYS_ROLE_MENU rm ON m.MENU_ID = rm.MENU_ID "
                    + "INNER JOIN SYS_ROLE ro ON ro.ROLE_ID = rm.ROLE_ID "
                    + "WHERE ro.ROLE_CODE = ? AND ro.STATUS = 1 ORDER BY m.SORT_ORDER, m.MENU_ID", roleCode);
        }
        List<String> paths = new ArrayList<>();
        for (Map<String, Object> r : rows) {
            String p = Values.str(r.get("MENU_PATH"));
            if (p != null) {
                paths.add(p);
            }
        }
        return paths.isEmpty() ? new ArrayList<>(MIN_MENUS) : paths;
    }

    public List<Map<String, Object>> listMenus() {
        if (!tablesReady()) {
            List<Map<String, Object>> out = new ArrayList<>();
            for (int i = 0; i < FALLBACK_MENUS_ALL.size(); i++) {
                String p = FALLBACK_MENUS_ALL.get(i);
                out.add(R.map("MENU_ID", i + 1, "MENU_PATH", p, "MENU_NAME", p, "SORT_ORDER", (i + 1) * 10));
            }
            return out;
        }
        return db.query("SELECT MENU_ID, MENU_PATH, MENU_NAME, SORT_ORDER FROM SYS_MENU ORDER BY SORT_ORDER, MENU_ID");
    }

    /** 角色代码是否存在且启用（RBAC 表不存在时接受内置角色） */
    public boolean roleExists(String roleCode) {
        if (roleCode == null) {
            return false;
        }
        if (!tablesReady()) {
            return List.of("ADMIN", "DBA", "OPS", "REVIEWER", "VIEWER", "DEV").contains(roleCode);
        }
        return db.count("SELECT COUNT(*) AS C FROM SYS_ROLE WHERE ROLE_CODE = ?", roleCode) > 0;
    }
}
