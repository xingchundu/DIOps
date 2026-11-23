package com.dbops.license;

import com.dbops.common.R;
import com.dbops.common.Values;
import com.dbops.security.CurrentUser;
import com.dbops.service.AuditService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * GET  /api/license/status    （无需登录）授权状态 + 机器码，登录页使用
 * POST /api/license/activate  （无需登录）导入授权；只接受验签通过、机器码一致、未过期的文件，所以不登录也安全
 * GET  /api/license/info      （需登录）客户、实例上限、历史授权
 */
@RestController
@RequestMapping("/api/license")
public class LicenseController {

    private final LicenseService license;
    private final AuditService audit;

    public LicenseController(LicenseService license, AuditService audit) {
        this.license = license;
        this.audit = audit;
    }

    @GetMapping("/status")
    public Map<String, Object> status() {
        return R.ok(license.publicStatus());
    }

    @PostMapping("/activate")
    public Map<String, Object> activate(@RequestBody(required = false) Map<String, Object> b) {
        String content = b == null ? null : Values.str(b.get("content"));
        if (content == null || content.isBlank()) {
            return R.badRequest("请上传或粘贴授权文件内容");
        }
        if (content.length() > 20_000) {
            return R.badRequest("授权文件过大");
        }
        Map<String, Object> s = license.activate(content, null, "license-activate");
        audit.log(null, "license-activate", "LICENSE_ACTIVATE", "SYS_LICENSE", null, null, "SUCCESS", String.valueOf(s.get("expiresAt")));
        return R.ok(s, "授权导入成功");
    }

    @GetMapping("/info")
    public Map<String, Object> info(CurrentUser u) {
        return R.ok(license.info());
    }
}
