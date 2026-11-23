package com.dbops.controller;

import com.dbops.common.Db;
import com.dbops.common.R;
import com.dbops.common.Values;
import com.dbops.security.CurrentUser;
import com.dbops.service.AuditService;
import com.dbops.service.RbacService;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * /api/rbac（同 Node routes/rbac.js），仅 ADMIN。
 */
@RestController
@RequestMapping("/api/rbac")
public class RbacController {

    private final Db db;
    private final RbacService rbac;
    private final AuditService audit;

    public RbacController(Db db, RbacService rbac, AuditService audit) {
        this.db = db;
        this.rbac = rbac;
        this.audit = audit;
    }

    @GetMapping("/menus")
    public Map<String, Object> menus(CurrentUser u) {
        u.require("ADMIN");
        return R.ok(rbac.listMenus());
    }

    @GetMapping("/roles")
    public Map<String, Object> roles(CurrentUser u) {
        u.require("ADMIN");
        if (!rbac.tablesReady()) {
            return R.ok(List.of(
                    R.map("ROLE_ID", 1, "ROLE_CODE", "ADMIN", "ROLE_NAME", "超级管理员", "STATUS", 1, "IS_SYSTEM", 1, "SORT_ORDER", 1),
                    R.map("ROLE_ID", 2, "ROLE_CODE", "DBA", "ROLE_NAME", "DBA", "STATUS", 1, "IS_SYSTEM", 1, "SORT_ORDER", 2),
                    R.map("ROLE_ID", 3, "ROLE_CODE", "OPS", "ROLE_NAME", "运维工程师", "STATUS", 1, "IS_SYSTEM", 1, "SORT_ORDER", 3),
                    R.map("ROLE_ID", 4, "ROLE_CODE", "REVIEWER", "ROLE_NAME", "审核员", "STATUS", 1, "IS_SYSTEM", 1, "SORT_ORDER", 4),
                    R.map("ROLE_ID", 5, "ROLE_CODE", "VIEWER", "ROLE_NAME", "只读用户", "STATUS", 1, "IS_SYSTEM", 1, "SORT_ORDER", 5),
                    R.map("ROLE_ID", 6, "ROLE_CODE", "DEV", "ROLE_NAME", "开发人员", "STATUS", 1, "IS_SYSTEM", 1, "SORT_ORDER", 6)));
        }
        return R.ok(db.query("SELECT ROLE_ID, ROLE_CODE, ROLE_NAME, STATUS, IS_SYSTEM, SORT_ORDER, CREATED_AT, UPDATED_AT "
                + "FROM SYS_ROLE ORDER BY SORT_ORDER, ROLE_ID"));
    }

    @PostMapping("/roles")
    public Map<String, Object> createRole(CurrentUser u, @RequestBody(required = false) Map<String, Object> body) {
        u.require("ADMIN");
        String code = Values.str(Values.get(body, "roleCode"), "").toUpperCase().replaceAll("[^A-Z0-9_]", "");
        if (code.isEmpty() || code.length() > 32) {
            return R.badRequest("角色代码无效（字母数字下划线，≤32）");
        }
        String name = Values.str(Values.get(body, "roleName"));
        if (name == null) {
            return R.badRequest("请填写角色名称");
        }
        int status = Values.toInt(Values.get(body, "status"), 1) == 0 ? 0 : 1;
        try {
            long sort = db.count("SELECT NVL(MAX(SORT_ORDER), 0) + 10 AS N FROM SYS_ROLE");
            db.update("INSERT INTO SYS_ROLE (ROLE_CODE, ROLE_NAME, STATUS, IS_SYSTEM, SORT_ORDER) VALUES (?, ?, ?, 0, ?)",
                    code, name, status, sort);
        } catch (Exception e) {
            if (Db.isUniqueViolation(e)) {
                return R.badRequest("角色代码已存在");
            }
            throw e;
        }
        audit.log(u, "CREATE_ROLE", code, null, "SUCCESS", null);
        return R.msg("角色已创建");
    }

    @PutMapping("/roles/{roleId}")
    public Map<String, Object> updateRole(CurrentUser u, @PathVariable("roleId") long roleId,
                                          @RequestBody(required = false) Map<String, Object> body) {
        u.require("ADMIN");
        Map<String, Object> row = db.one("SELECT ROLE_ID, IS_SYSTEM, ROLE_CODE, ROLE_NAME FROM SYS_ROLE WHERE ROLE_ID = ?", roleId);
        if (row == null) {
            return R.notFound("角色不存在");
        }
        String newName = Values.str(Values.get(body, "roleName"));
        Object statusRaw = Values.get(body, "status");
        // [fix] Node 版只要请求体带 roleName（编辑表单总会带上）就拒绝内置角色，导致内置角色无法启停；这里只在名称真正变化时拒绝
        boolean renaming = newName != null && !newName.equals(Values.str(row.get("ROLE_NAME")));
        if (Values.toInt(row.get("IS_SYSTEM"), 0) == 1 && renaming) {
            return R.badRequest("内置角色不可改名");
        }
        Integer st = null;
        if (statusRaw != null) {
            st = Values.toInt(statusRaw, 1) == 0 ? 0 : 1;
            if (st == 0 && "ADMIN".equals(row.get("ROLE_CODE"))) {
                return R.badRequest("不能禁用超级管理员角色");
            }
        }
        if (renaming) {
            db.update("UPDATE SYS_ROLE SET ROLE_NAME = ?, UPDATED_AT = SYSTIMESTAMP WHERE ROLE_ID = ?", newName, roleId);
        }
        if (st != null) {
            db.update("UPDATE SYS_ROLE SET STATUS = ?, UPDATED_AT = SYSTIMESTAMP WHERE ROLE_ID = ?", st, roleId);
        }
        return R.msg("已更新");
    }

    @DeleteMapping("/roles/{roleId}")
    public Map<String, Object> deleteRole(CurrentUser u, @PathVariable("roleId") long roleId) {
        u.require("ADMIN");
        Map<String, Object> row = db.one("SELECT ROLE_ID, IS_SYSTEM, ROLE_CODE FROM SYS_ROLE WHERE ROLE_ID = ?", roleId);
        if (row == null) {
            return R.notFound("角色不存在");
        }
        if (Values.toInt(row.get("IS_SYSTEM"), 0) == 1) {
            return R.badRequest("不能删除内置角色");
        }
        if (db.count("SELECT COUNT(*) AS C FROM SYS_USER WHERE ROLE = ?", row.get("ROLE_CODE")) > 0) {
            return R.badRequest("仍有用户使用该角色，无法删除");
        }
        db.update("DELETE FROM SYS_ROLE WHERE ROLE_ID = ?", roleId);
        audit.log(u, "DELETE_ROLE", String.valueOf(row.get("ROLE_CODE")), String.valueOf(roleId), "SUCCESS", null);
        return R.msg("已删除");
    }

    @GetMapping("/roles/{roleId}/menus")
    public Map<String, Object> roleMenus(CurrentUser u, @PathVariable("roleId") long roleId) {
        u.require("ADMIN");
        if (!rbac.tablesReady()) {
            return R.ok(R.map("menuIds", List.of()));
        }
        if (db.one("SELECT ROLE_ID FROM SYS_ROLE WHERE ROLE_ID = ?", roleId) == null) {
            return R.notFound("角色不存在");
        }
        List<Object> ids = new ArrayList<>();
        for (Map<String, Object> r : db.query("SELECT m.MENU_ID FROM SYS_MENU m INNER JOIN SYS_ROLE_MENU rm ON m.MENU_ID = rm.MENU_ID "
                + "WHERE rm.ROLE_ID = ? ORDER BY m.SORT_ORDER, m.MENU_ID", roleId)) {
            ids.add(r.get("MENU_ID"));
        }
        return R.ok(R.map("menuIds", ids));
    }

    @PutMapping("/roles/{roleId}/menus")
    public Map<String, Object> saveRoleMenus(CurrentUser u, @PathVariable("roleId") long roleId,
                                             @RequestBody(required = false) Map<String, Object> body) {
        u.require("ADMIN");
        Set<Long> menuIds = new LinkedHashSet<>();
        if (Values.get(body, "menuIds") instanceof List<?> l) {
            for (Object o : l) {
                Long id = Values.toLong(o);
                if (id != null) {
                    menuIds.add(id);
                }
            }
        }
        Map<String, Object> row = db.one("SELECT ROLE_ID, ROLE_CODE FROM SYS_ROLE WHERE ROLE_ID = ?", roleId);
        if (row == null) {
            return R.notFound("角色不存在");
        }
        if ("ADMIN".equals(row.get("ROLE_CODE"))) {
            return R.badRequest("超级管理员固定拥有全部菜单，无需分配");
        }
        // [fix] Node 版先 DELETE 再逐条 INSERT 且自动提交：中途失败（如菜单 ID 不存在触发外键错误）会让角色丢失全部菜单
        db.inTx(() -> {
            db.update("DELETE FROM SYS_ROLE_MENU WHERE ROLE_ID = ?", roleId);
            for (Long mid : menuIds) {
                db.update("INSERT INTO SYS_ROLE_MENU (ROLE_ID, MENU_ID) VALUES (?, ?)", roleId, mid);
            }
        });
        audit.log(u, "SAVE_ROLE_MENUS", String.valueOf(row.get("ROLE_CODE")), String.valueOf(roleId), "SUCCESS",
                "menus=" + menuIds);
        return R.msg("权限已保存");
    }
}
