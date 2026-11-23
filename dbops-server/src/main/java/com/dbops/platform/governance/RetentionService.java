package com.dbops.platform.governance;

import com.dbops.common.Db;
import com.dbops.common.Values;
import com.dbops.service.SystemConfigService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 统一数据保留清理（阶段2，增量于 CollectService / SqlInsight purge）。
 * 修改者: dxc | 时间: 2026-11-12
 */
@Service
public class RetentionService {

    private static final Logger log = LoggerFactory.getLogger(RetentionService.class);

    private final Db db;
    private final SystemConfigService cfg;
    private final GovernanceProperties props;

    public RetentionService(Db db, SystemConfigService cfg, GovernanceProperties props) {
        this.db = db;
        this.cfg = cfg;
        this.props = props;
    }

    public boolean tablesReady() {
        try {
            db.query("SELECT 1 FROM DATA_RETENTION_RUN WHERE 1=0");
            return true;
        } catch (Exception e) {
            if (Db.isMissingTable(e)) {
                return false;
            }
            throw e instanceof RuntimeException re ? re : new RuntimeException(e);
        }
    }

    public List<Map<String, Object>> runAll() {
        List<Map<String, Object>> summary = new ArrayList<>();
        int batch = props.retentionBatch();
        runTask(summary, "audit_log", "retention.audit_log_days", 180,
                "DELETE FROM SYS_AUDIT_LOG WHERE CREATED_AT < SYSTIMESTAMP - NUMTODSINTERVAL(?, 'DAY') AND ROWNUM <= " + batch);
        runTask(summary, "automation_exec", "retention.automation_exec_days", 90,
                "DELETE FROM AUTOMATION_EXEC_LOG WHERE CREATED_AT < SYSTIMESTAMP - NUMTODSINTERVAL(?, 'DAY') AND ROWNUM <= " + batch);
        runTask(summary, "script_exec", "retention.script_exec_days", 90,
                "DELETE FROM SCRIPT_EXEC_LOG WHERE CREATED_AT < SYSTIMESTAMP - NUMTODSINTERVAL(?, 'DAY') AND ROWNUM <= " + batch);
        runTask(summary, "ai_chat", "retention.ai_chat_days", 90,
                "DELETE FROM AI_CHAT_HISTORY WHERE CREATED_AT < SYSTIMESTAMP - NUMTODSINTERVAL(?, 'DAY') AND ROWNUM <= " + batch);
        runTask(summary, "inspect_result", "retention.inspect_result_days", 180,
                "DELETE FROM INSPECT_RESULT WHERE CHECK_TIME < SYSTIMESTAMP - NUMTODSINTERVAL(?, 'DAY') AND ROWNUM <= " + batch);
        runTask(summary, "inspect_report", "retention.inspect_report_days", 365,
                "DELETE FROM INSPECT_REPORT WHERE CREATED_AT < SYSTIMESTAMP - NUMTODSINTERVAL(?, 'DAY') AND ROWNUM <= " + batch);
        runTask(summary, "di_anomaly", "retention.di_anomaly_days", 180,
                "DELETE FROM DI_SQL_ANOMALY WHERE STATUS <> 'OPEN' AND NVL(RESOLVED_AT, LAST_TIME) < SYSTIMESTAMP - NUMTODSINTERVAL(?, 'DAY') AND ROWNUM <= " + batch);
        runTask(summary, "di_problem", "retention.di_problem_days", 180,
                "DELETE FROM DI_SQL_PROBLEM WHERE STATUS <> 'OPEN' AND LAST_SEEN < SYSTIMESTAMP - NUMTODSINTERVAL(?, 'DAY') AND ROWNUM <= " + batch);
        return summary;
    }

    private void runTask(List<Map<String, Object>> summary, String key, String configKey, int defDays, String deleteSql) {
        long days = Math.max(0, cfg.getLong(configKey, defDays));
        if (days <= 0) {
            return;
        }
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("task", key);
        row.put("keepDays", days);
        try {
            int n = db.update(deleteSql, days);
            logPhase2Run(key, n, days, "OK", null);
            row.put("deleted", n);
            row.put("status", "OK");
        } catch (Exception e) {
            if (Db.isMissingTable(e)) {
                row.put("status", "SKIP_NO_TABLE");
            } else {
                logPhase2Run(key, 0, days, "ERROR", Values.truncate(e.getMessage(), 500));
                row.put("status", "ERROR");
                row.put("error", e.getMessage());
                log.warn("[phase2-retention] {}: {}", key, e.getMessage());
            }
        }
        summary.add(row);
    }

    private void logPhase2Run(String taskKey, int deleted, long keepDays, String status, String detail) {
        if (!tablesReady()) {
            return;
        }
        try {
            db.update("INSERT INTO DATA_RETENTION_RUN (TASK_KEY, DELETED_ROWS, KEEP_DAYS, STATUS, DETAIL, FINISHED_AT) "
                            + "VALUES (?, ?, ?, ?, ?, SYSTIMESTAMP)",
                    taskKey, deleted, keepDays, status, detail);
        } catch (Exception e) {
            log.debug("[phase2-retention] log run: {}", e.getMessage());
        }
    }

    public List<Map<String, Object>> recentRuns(int limit) {
        int n = Math.max(1, Math.min(limit, 200));
        try {
            return db.query("SELECT * FROM DATA_RETENTION_RUN ORDER BY STARTED_AT DESC FETCH FIRST " + n + " ROWS ONLY");
        } catch (Exception e) {
            if (Db.isMissingTable(e)) {
                return List.of();
            }
            throw e;
        }
    }
}
