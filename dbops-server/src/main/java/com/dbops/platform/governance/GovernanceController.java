package com.dbops.platform.governance;

import com.dbops.common.R;
import com.dbops.common.Values;
import com.dbops.security.CurrentUser;
import com.dbops.service.AuditService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 阶段2运维闭环 API（/api/platform/governance/**）。
 * 修改者: dxc | 时间: 2026-11-12
 */
@RestController
@RequestMapping("/api/platform/governance")
public class GovernanceController {

    private final GovernanceProperties props;
    private final RetentionService retention;
    private final EscalationService escalation;
    private final MaintenanceService maintenance;
    private final InspectCompareService inspectCompare;
    private final RestoreDrillService restoreDrill;
    private final AuditService audit;

    public GovernanceController(GovernanceProperties props, RetentionService retention, EscalationService escalation,
                               MaintenanceService maintenance, InspectCompareService inspectCompare,
                               RestoreDrillService restoreDrill, AuditService audit) {
        this.props = props;
        this.retention = retention;
        this.escalation = escalation;
        this.maintenance = maintenance;
        this.inspectCompare = inspectCompare;
        this.restoreDrill = restoreDrill;
        this.audit = audit;
    }

    @GetMapping("/status")
    public Map<String, Object> status(CurrentUser u) {
        u.require("ADMIN", "DBA", "OPS");
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("opsEnabled", props.opsEnabled());
        m.put("retentionReady", retention.tablesReady());
        m.put("escalationReady", escalation.tablesReady());
        m.put("maintenanceReady", maintenance.tablesReady());
        return R.ok(m);
    }

    @PostMapping("/retention/run-once")
    public Map<String, Object> runRetention(CurrentUser u) {
        u.require("ADMIN", "DBA");
        List<Map<String, Object>> summary = retention.runAll();
        audit.log(u, "DATA_RETENTION_RUN", "DATA_RETENTION", null, "SUCCESS", String.valueOf(summary.size()));
        return R.ok(summary, "清理完成");
    }

    @GetMapping("/retention/runs")
    public Map<String, Object> retentionRuns(CurrentUser u, @RequestParam(defaultValue = "50") String limit) {
        u.require("ADMIN", "DBA", "OPS");
        return R.ok(retention.recentRuns(Values.toInt(limit, 50)));
    }

    @PostMapping("/escalation/run-once")
    public Map<String, Object> runEscalation(CurrentUser u) {
        u.require("ADMIN", "DBA");
        int n = escalation.runEscalation();
        return R.ok(Map.of("escalated", n));
    }

    @GetMapping("/escalation/logs")
    public Map<String, Object> escalationLogs(CurrentUser u, @RequestParam(defaultValue = "50") String limit) {
        u.require("ADMIN", "DBA", "OPS");
        return R.ok(escalation.recentLogs(Values.toInt(limit, 50)));
    }

    @GetMapping("/escalation/by-alert/{alertId}")
    public Map<String, Object> escalationByAlert(CurrentUser u, @PathVariable long alertId) {
        u.require("ADMIN", "DBA", "OPS", "VIEWER");
        return R.ok(escalation.logsByAlert(alertId));
    }

    @PostMapping("/maintenance/run-once")
    public Map<String, Object> runMaintenance(CurrentUser u) {
        u.require("ADMIN", "DBA");
        int n = maintenance.silenceAlertsInMaintenance();
        return R.ok(Map.of("silenced", n));
    }

    @GetMapping("/maintenance/windows")
    public Map<String, Object> listWindows(CurrentUser u) {
        u.require("ADMIN", "DBA", "OPS");
        return R.ok(maintenance.listMaintenanceWindows());
    }

    @PostMapping("/maintenance/windows")
    public Map<String, Object> saveWindow(CurrentUser u, @RequestBody Map<String, Object> body) {
        u.require("ADMIN", "DBA");
        maintenance.saveMaintenanceWindow(body, u.username());
        audit.log(u, "ALERT_MAINT_WINDOW", "ALERT_MAINTENANCE_WINDOW", Values.str(body.get("title")), "SUCCESS", null);
        return R.msg("已保存");
    }

    @GetMapping("/inspect/compare")
    public Map<String, Object> inspectCompare(CurrentUser u,
                                              @RequestParam long baseReportId,
                                              @RequestParam(required = false) Long prevReportId) {
        u.require("ADMIN", "DBA", "OPS");
        return R.ok(inspectCompare.compare(baseReportId, prevReportId));
    }

    @GetMapping("/restore-drill/list")
    public Map<String, Object> restoreDrillList(CurrentUser u, @RequestParam(defaultValue = "50") String limit) {
        u.require("ADMIN", "DBA", "OPS");
        return R.ok(restoreDrill.recent(Values.toInt(limit, 50)));
    }
}
