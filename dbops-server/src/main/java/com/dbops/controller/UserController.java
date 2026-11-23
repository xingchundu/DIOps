package com.dbops.controller;

import com.dbops.common.Db;
import com.dbops.common.R;
import com.dbops.common.Values;
import com.dbops.security.AuthFilter;
import com.dbops.security.CurrentUser;
import com.dbops.service.AuditService;
import com.dbops.service.RbacService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * /api/users（同 Node routes/users.js），全部仅 ADMIN 可用。
 */
@RestController
@RequestMapping("/api/users")
public class UserController {

    private final Db db;
    private final AuditService audit;
    private final RbacService rbac;
    private final AuthFilter authFilter;

    public UserController(Db db, AuditService audit, RbacService rbac, AuthFilter authFilter) {
        this.db = db;
        this.audit = audit;
        this.rbac = rbac;
        this.authFilter = authFilter;
    }

    @GetMapping
    public Map<String, Object> list(CurrentUser u,
                                    @RequestParam(required = false) String keyword,
                                    @RequestParam(required = false) String role,
                                    @RequestParam(required = false) String status,
                                    @RequestParam(required = false, defaultValue = "1") String page,
                                    @RequestParam(required = false, defaultValue = "20") String size) {
        if (!u.isAdmin()) {
            return R.forbidden();
        }
        List<String> where = new ArrayList<>(List.of("1=1"));
        List<Object> args = new ArrayList<>();
        if (!Values.isBlank(keyword)) {
            where.add("(u.USERNAME LIKE ? OR u.REAL_NAME LIKE ?)");
            args.add("%" + keyword.trim() + "%");
            args.add("%" + keyword.trim() + "%");
        }
        if (!Values.isBlank(role)) {
            where.add("u.ROLE = ?");
            args.add(role.trim());
        }
        if (!Values.isBlank(status)) {
            where.add("u.STATUS = ?");
            args.add(Values.toInt(status, 1));
        }
        String w = String.join(" AND ", where);
        String sql = "SELECT u.USER_ID,u.USERNAME,u.REAL_NAME,u.EMAIL,u.PHONE,u.ROLE,u.STATUS,u.LAST_LOGIN,u.CREATED_AT, "
                + "NVL(r.ROLE_NAME, u.ROLE) AS ROLE_NAME FROM SYS_USER u LEFT JOIN SYS_ROLE r ON r.ROLE_CODE = u.ROLE "
                + "WHERE " + w + " ORDER BY u.USER_ID";
        try {
            return R.ok(db.queryPage(sql, args, page, size));
        } catch (Exception e) {
            if (!Db.isMissingTable(e)) {
                throw e;
            }
            String fallback = "SELECT u.USER_ID,u.USERNAME,u.REAL_NAME,u.EMAIL,u.PHONE,u.ROLE,u.STATUS,u.LAST_LOGIN,u.CREATED_AT, "
                    + "u.ROLE AS ROLE_NAME FROM SYS_USER u WHERE " + w + " ORDER BY u.USER_ID";
            return R.ok(db.queryPage(fallback, args, page, size));
        }
    }

    @PostMapping
    public Map<String, Object> create(CurrentUser u, @RequestBody(required = false) Map<String, Object> body) {
        if (!u.isAdmin()) {
            return R.forbidden();
        }
        String username = Values.str(Values.get(body, "username"));
        String password = Values.raw(Values.get(body, "password"));
        if (username == null || Values.isBlank(password)) {
            return R.badRequest("用户名和密码不能为空");
        }
        // [fix] Node 版创建用户不校验密码强度（修改密码时却要求），管理员可建出弱口令账号
        String err = AuthController.validateNewPassword(password);
        if (err != null) {
            return R.badRequest(err);
        }
        String role = Values.str(Values.get(body, "role"), "VIEWER");
        if (!rbac.roleExists(role)) {
            return R.badRequest("角色不存在: " + role);
        }
        if (db.count("SELECT COUNT(*) FROM SYS_USER WHERE USERNAME=?", username) > 0) {
            return R.badRequest("用户名已存在");
        }
        db.update("INSERT INTO SYS_USER(USERNAME,PASSWORD_HASH,REAL_NAME,EMAIL,PHONE,ROLE,STATUS,TENANT_ID) VALUES(?,?,?,?,?,?,1,?)",
                username, AuthController.hashPassword(password), Values.str(Values.get(body, "realName")),
                Values.str(Values.get(body, "email")), Values.str(Values.get(body, "phone")), role,
                u.tenantId() == null ? 1L : u.tenantId());
        audit.log(u, "CREATE_USER", username, null, "SUCCESS", null);
        return R.msg("用户创建成功");
    }

    @PutMapping("/{id}")
    public Map<String, Object> update(CurrentUser u, @PathVariable("id") long id, @RequestBody(required = false) Map<String, Object> body) {
        if (!u.isAdmin()) {
            return R.forbidden();
        }
        Map<String, Object> old = db.one("SELECT ROLE, STATUS FROM SYS_USER WHERE USER_ID=?", id);
        if (old == null) {
            return R.notFound("用户不存在");
        }
        String role = Values.str(Values.get(body, "role"), Values.str(old.get("ROLE")));
        Integer status = Values.toInt(Values.get(body, "status"));
        if (status == null) {
            status = Values.toInt(old.get("STATUS"), 1);
        }
        status = status == 0 ? 0 : 1;
        if (!rbac.roleExists(role)) {
            return R.badRequest("角色不存在: " + role);
        }
        // [fix] Node 版 PUT 可把自己改成禁用或非 ADMIN（disable 接口有自我保护，这里没有），导致系统无管理员
        if (id == u.userId() && (status == 0 || !"ADMIN".equals(role))) {
            return R.badRequest("不能禁用自身账号或取消自身管理员角色");
        }
        db.update("UPDATE SYS_USER SET REAL_NAME=?,EMAIL=?,PHONE=?,ROLE=?,STATUS=?,UPDATED_AT=SYSTIMESTAMP WHERE USER_ID=?",
                Values.str(Values.get(body, "realName")), Values.str(Values.get(body, "email")),
                Values.str(Values.get(body, "phone")), role, status, id);
        authFilter.evict(id);
        audit.log(u, "UPDATE_USER", String.valueOf(id), String.valueOf(id), "SUCCESS", "role=" + role + ",status=" + status);
        return R.msg("更新成功");
    }

    @PostMapping("/{id}/disable")
    public Map<String, Object> disable(CurrentUser u, @PathVariable("id") long id) {
        if (!u.isAdmin()) {
            return R.forbidden();
        }
        if (id == u.userId()) {
            return R.badRequest("不能禁用自身账号");
        }
        db.update("UPDATE SYS_USER SET STATUS=0,UPDATED_AT=SYSTIMESTAMP WHERE USER_ID=?", id);
        authFilter.evict(id);
        audit.log(u, "DISABLE_USER", String.valueOf(id), String.valueOf(id), "SUCCESS", null);
        return R.msg("账号已禁用");
    }

    @PostMapping("/{id}/enable")
    public Map<String, Object> enable(CurrentUser u, @PathVariable("id") long id) {
        if (!u.isAdmin()) {
            return R.forbidden();
        }
        db.update("UPDATE SYS_USER SET STATUS=1,UPDATED_AT=SYSTIMESTAMP WHERE USER_ID=?", id);
        authFilter.evict(id);
        audit.log(u, "ENABLE_USER", String.valueOf(id), String.valueOf(id), "SUCCESS", null);
        return R.msg("账号已启用");
    }

    @GetMapping("/audit")
    public Map<String, Object> auditList(CurrentUser u,
                                         @RequestParam(required = false) String userId,
                                         @RequestParam(required = false) String action,
                                         @RequestParam(required = false, defaultValue = "1") String page,
                                         @RequestParam(required = false, defaultValue = "20") String size) {
        if (!u.isAdmin()) {
            return R.forbidden();
        }
        List<String> where = new ArrayList<>(List.of("1=1"));
        List<Object> args = new ArrayList<>();
        if (!Values.isBlank(userId)) {
            where.add("USER_ID=?");
            args.add(Values.toLong(userId));
        }
        if (!Values.isBlank(action)) {
            where.add("ACTION=?");
            args.add(action.trim());
        }
        String sql = "SELECT * FROM SYS_AUDIT_LOG WHERE " + String.join(" AND ", where) + " ORDER BY CREATED_AT DESC";
        return R.ok(db.queryPage(sql, args, page, size));
    }
}
