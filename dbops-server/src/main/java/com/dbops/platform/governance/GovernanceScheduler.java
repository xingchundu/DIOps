package com.dbops.platform.governance;

import com.dbops.common.Values;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * 阶段2定时任务（保留/升级/维护静默）。
 * 修改者: dxc | 时间: 2026-11-12
 */
@Component
public class GovernanceScheduler {

    private static final Logger log = LoggerFactory.getLogger(GovernanceScheduler.class);

    private final GovernanceProperties props;
    private final RetentionService retention;
    private final EscalationService escalation;
    private final MaintenanceService maintenance;

    public GovernanceScheduler(GovernanceProperties props, RetentionService retention,
                              EscalationService escalation, MaintenanceService maintenance) {
        this.props = props;
        this.retention = retention;
        this.escalation = escalation;
        this.maintenance = maintenance;
    }

    @Scheduled(cron = "0 15 * * * *", zone = "Asia/Shanghai")
    public void hourlyRetention() {
        if (!props.retentionEnabled() || !retention.tablesReady()) {
            return;
        }
        try {
            var s = retention.runAll();
            long del = s.stream().mapToLong(r -> {
                Double d = Values.toDouble(r.get("deleted"));
                return d == null ? 0 : d.longValue();
            }).sum();
            if (del > 0) {
                log.info("[phase2-retention] deleted total {}", del);
            }
        } catch (Exception e) {
            log.warn("[phase2-retention] {}", e.getMessage());
        }
    }

    @Scheduled(fixedDelay = 300_000L, initialDelay = 90_000L)
    public void escalationTick() {
        if (!props.escalationEnabled() || !escalation.tablesReady()) {
            return;
        }
        try {
            int n = escalation.runEscalation();
            if (n > 0) {
                log.info("[phase2-escalation] escalated {}", n);
            }
        } catch (Exception e) {
            log.warn("[phase2-escalation] {}", e.getMessage());
        }
    }

    @Scheduled(fixedDelay = 120_000L, initialDelay = 60_000L)
    public void maintenanceTick() {
        if (!props.maintenanceEnabled() || !maintenance.tablesReady()) {
            return;
        }
        try {
            maintenance.silenceAlertsInMaintenance();
        } catch (Exception e) {
            log.warn("[phase2-maintenance] {}", e.getMessage());
        }
    }
}
