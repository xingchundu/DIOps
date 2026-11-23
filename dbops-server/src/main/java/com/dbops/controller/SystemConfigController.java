package com.dbops.controller;

import com.dbops.common.Db;
import com.dbops.common.R;
import com.dbops.common.Values;
import com.dbops.security.CurrentUser;
import com.dbops.service.AuditService;
import com.dbops.service.SystemConfigService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * /api/system-config（同 Node routes/systemConfig.js）
 */
@RestController
@RequestMapping("/api/system-config")
public class SystemConfigController {

    private final Db db;
    private final SystemConfigService cfg;
    private final AuditService audit;

    public SystemConfigController(Db db, SystemConfigService cfg, AuditService audit) {
        this.db = db;
        this.cfg = cfg;
        this.audit = audit;
    }

    @GetMapping
    public Map<String, Object> all(CurrentUser u) {
        boolean privileged = u != null && (u.isAdmin() || u.hasRole("DBA"));
        return R.ok(com.dbops.service.SystemConfigMask.maskForReader(cfg.getAll(), privileged));
    }

    // reload 必须写在 /{key} 之前不影响：Spring 优先匹配字面量路径
    @PostMapping("/reload")
    public Map<String, Object> reload(CurrentUser u) {
        u.require("ADMIN", "DBA");
        cfg.loadAll();
        return R.msg("配置已重新加载");
    }

    @PutMapping("/{key}")
    public Map<String, Object> update(CurrentUser u, @PathVariable("key") String key,
                                      @RequestBody(required = false) Map<String, Object> body) {
        u.require("ADMIN", "DBA");
        Object value = Values.get(body, "value");
        if (value == null) {
            return R.badRequest("值不能为空");
        }
        Map<String, Object> row = db.one("SELECT MIN_VAL, MAX_VAL, VALUE_TYPE, OPTIONS FROM SYS_CONFIG WHERE CONFIG_KEY=?", key);
        if (row == null) {
            return R.notFound("配置项不存在");
        }
        String strVal = String.valueOf(value).trim();
        String type = Values.str(row.get("VALUE_TYPE"), "");
        if ("NUMBER".equalsIgnoreCase(type)) {
            Double n = Values.toDouble(strVal);
            if (n == null) {
                return R.badRequest("值必须为数字");
            }
            Double min = Values.toDouble(row.get("MIN_VAL"));
            Double max = Values.toDouble(row.get("MAX_VAL"));
            if (min != null && n < min) {
                return R.badRequest("值不能小于 " + row.get("MIN_VAL"));
            }
            if (max != null && n > max) {
                return R.badRequest("值不能大于 " + row.get("MAX_VAL"));
            }
        } else if ("BOOLEAN".equalsIgnoreCase(type)) {
            if (!List.of("0", "1", "true", "false").contains(strVal.toLowerCase())) {
                return R.badRequest("值必须为布尔值");
            }
        }
        if (strVal.length() > 512) {
            return R.badRequest("值长度不能超过 512");
        }
        cfg.set(key, strVal, u.userId());
        audit.log(u, "UPDATE_CONFIG", "SystemConfig", key, "SUCCESS", key + "=" + strVal);
        return R.msg("配置已更新");
    }

    @PostMapping("/{key}/reset")
    public Map<String, Object> reset(CurrentUser u, @PathVariable("key") String key) {
        u.require("ADMIN", "DBA");
        cfg.reset(key, u.userId());
        return R.msg("已重置为默认值");
    }
}
