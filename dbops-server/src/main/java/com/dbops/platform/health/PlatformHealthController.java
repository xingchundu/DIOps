package com.dbops.platform.health;

import com.dbops.platform.PlatformProperties;
import com.dbops.common.R;
import com.dbops.common.Values;
import com.dbops.security.CurrentUser;
import com.dbops.service.AuditService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 阶段3交付 API：自监控 / OpenAPI 入口 / 状态。
 * 修改者: dxc | 时间: 2026-11-12
 */
@RestController
@RequestMapping("/api/platform")
public class PlatformHealthController {

    private final PlatformProperties props;
    private final PlatformHealthCollector health;
    private final AuditService audit;

    public PlatformHealthController(PlatformProperties props, PlatformHealthCollector health, AuditService audit) {
        this.props = props;
        this.health = health;
        this.audit = audit;
    }

    @GetMapping("/status")
    public Map<String, Object> status(CurrentUser u) {
        u.require("ADMIN", "DBA", "OPS");
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("deliveryEnabled", props.deliveryEnabled());
        m.put("openApiEnabled", props.openApiEnabled());
        m.put("ssoEnabled", props.ssoEnabled());
        m.put("healthEnabled", props.healthEnabled());
        m.put("healthReady", health.tablesReady());
        return R.ok(m);
    }

    @GetMapping("/health/latest")
    public Map<String, Object> healthLatest(CurrentUser u) {
        u.require("ADMIN", "DBA", "OPS");
        return R.ok(health.latestMetrics());
    }

    @GetMapping("/health/history")
    public Map<String, Object> healthHistory(CurrentUser u, @RequestParam(defaultValue = "collect_success_pct") String key,
                                             @RequestParam(defaultValue = "48") String hours) {
        u.require("ADMIN", "DBA", "OPS");
        if (!health.tablesReady()) {
            return R.ok(List.of());
        }
        int h = Math.max(1, Math.min(Values.toInt(hours, 48), 168));
        List<Map<String, Object>> rows = health.history(key, h);
        return R.ok(rows);
    }

    @PostMapping("/health/run-once")
    public Map<String, Object> runHealth(CurrentUser u) {
        u.require("ADMIN", "DBA");
        List<Map<String, Object>> m = health.collectAndPersist();
        audit.log(u, "PHASE3_HEALTH_RUN", "PLATFORM_HEALTH", null, "SUCCESS", String.valueOf(m.size()));
        return R.ok(m, "采集完成");
    }

    @GetMapping("/openapi/links")
    public Map<String, Object> openApiLinks(CurrentUser u) {
        u.require("ADMIN", "DBA");
        Map<String, Object> links = new LinkedHashMap<>();
        links.put("javaApiDocs", "/v3/api-docs");
        links.put("javaSwaggerUi", "/swagger-ui/index.html");
        links.put("nodeOpenApi", "/docs/openapi-node.yaml");
        links.put("enabled", props.openApiEnabled());
        return R.ok(links);
    }
}
