package com.dbops.platform.governance;

import com.dbops.service.SystemConfigService;
import org.springframework.stereotype.Component;

/**
 * 阶段2运维闭环配置（SYS_CONFIG）。
 * 修改者: dxc | 时间: 2026-11-12
 */
@Component
public class GovernanceProperties {

    private final SystemConfigService cfg;

    public GovernanceProperties(SystemConfigService cfg) {
        this.cfg = cfg;
    }

    private boolean platformOn() {
        return cfg.getBool("platform.enabled", cfg.getBool("phase3.delivery.enabled", false));
    }

    public boolean opsEnabled() {
        return platformOn() && cfg.getBool("governance.enabled", cfg.getBool("phase2.ops.enabled", false));
    }

    public boolean retentionEnabled() {
        return opsEnabled() && cfg.getBool("retention.job_enabled", true);
    }

    public int retentionBatch() {
        return (int) Math.max(100, Math.min(20_000, cfg.getLong("retention.batch_size", 3000)));
    }

    public boolean escalationEnabled() {
        return opsEnabled() && cfg.getBool("alert.escalation.enabled", true);
    }

    public long escalationAckTimeoutMin() {
        return Math.max(5, cfg.getLong("alert.escalation.ack_timeout_min", 30));
    }

    public boolean bumpSeverity() {
        return cfg.getBool("alert.escalation.bump_severity", true);
    }

    public boolean maintenanceEnabled() {
        return opsEnabled() && cfg.getBool("alert.maintenance.enabled", true);
    }

    public boolean useDiChangeWindow() {
        return cfg.getBool("alert.maintenance.use_di_change_window", true);
    }
}
