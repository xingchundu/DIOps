package com.dbops.platform.governance;

import com.dbops.common.Db;
import com.dbops.common.Values;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 维护/变更窗口内静默监控 OPEN 告警（不改 AlertEvaluator）。
 * 修改者: dxc | 时间: 2026-11-12
 */
@Service
public class MaintenanceService {

    private static final Logger log = LoggerFactory.getLogger(MaintenanceService.class);

    private final Db db;
    private final GovernanceProperties props;

    public MaintenanceService(Db db, GovernanceProperties props) {
        this.db = db;
        this.props = props;
    }

    public int silenceAlertsInMaintenance() {
        if (!tablesReady()) {
            return 0;
        }
        List<Window> windows = activeWindows();
        if (windows.isEmpty()) {
            return 0;
        }
        int total = 0;
        for (Window w : windows) {
            List<Map<String, Object>> open = w.instanceId == null
                    ? db.query("SELECT ALERT_ID, INSTANCE_ID FROM ALERT_RECORD WHERE STATUS = 'OPEN'")
                    : db.query("SELECT ALERT_ID, INSTANCE_ID FROM ALERT_RECORD WHERE STATUS = 'OPEN' AND NVL(INSTANCE_ID, -1) = ?",
                    w.instanceId);
            for (Map<String, Object> a : open) {
                long aid = Values.toLong(a.get("ALERT_ID"), 0);
                int u = db.update("UPDATE ALERT_RECORD SET STATUS='SILENCED', DETAIL=NVL(DETAIL,'') || ? "
                                + "WHERE ALERT_ID=? AND STATUS='OPEN'",
                        " [维护窗:" + Values.truncate(w.title, 80) + "]", aid);
                if (u > 0) {
                    db.update("INSERT INTO ALERT_MAINTENANCE_SILENCE_LOG (ALERT_ID, INSTANCE_ID, WINDOW_SOURCE, WINDOW_TITLE, ACTION) "
                                    + "VALUES (?, ?, ?, ?, 'SILENCE')",
                            aid, a.get("INSTANCE_ID"), w.source, w.title);
                    total++;
                }
            }
        }
        if (total > 0) {
            log.info("[phase2-maintenance] silenced {} alerts", total);
        }
        return total;
    }

    private List<Window> activeWindows() {
        List<Window> out = new ArrayList<>();
        try {
            for (Map<String, Object> r : db.query(
                    "SELECT INSTANCE_ID, TITLE, START_TIME, END_TIME FROM ALERT_MAINTENANCE_WINDOW "
                            + "WHERE NVL(ENABLED,1)=1 AND SYSTIMESTAMP BETWEEN START_TIME AND END_TIME")) {
                out.add(new Window(Values.toLong(r.get("INSTANCE_ID"), 0) == 0 ? null : Values.toLong(r.get("INSTANCE_ID"), 0),
                        Values.str(r.get("TITLE"), "维护窗"), r.get("START_TIME"), r.get("END_TIME"), "MONITOR"));
            }
        } catch (Exception e) {
            if (!Db.isMissingTable(e)) {
                log.warn("[phase2-maintenance] monitor windows: {}", e.getMessage());
            }
        }
        if (props.useDiChangeWindow()) {
            try {
                for (Map<String, Object> r : db.query(
                        "SELECT INSTANCE_ID, TITLE, START_TIME, END_TIME FROM DI_CHANGE_WINDOW "
                                + "WHERE SYSTIMESTAMP BETWEEN START_TIME AND END_TIME")) {
                    Long iid = Values.toLong(r.get("INSTANCE_ID"), 0);
                    out.add(new Window(iid == 0 ? null : iid, Values.str(r.get("TITLE"), "变更窗"),
                            r.get("START_TIME"), r.get("END_TIME"), "DI_CHANGE_WINDOW"));
                }
            } catch (Exception e) {
                if (!Db.isMissingTable(e)) {
                    log.warn("[phase2-maintenance] di change windows: {}", e.getMessage());
                }
            }
        }
        return out;
    }

    public void saveMaintenanceWindow(Map<String, Object> body, String username) {
        Long id = Values.toLong(body.get("windowId"), 0);
        Long inst = Values.toLong(body.get("instanceId"), 0);
        Long instanceId = inst == 0 ? null : inst;
        String title = Values.str(body.get("title"), "维护窗口");
        Object start = body.get("startTime");
        Object end = body.get("endTime");
        if (start == null || end == null) {
            throw new IllegalArgumentException("开始/结束时间必填");
        }
        int en = Values.truthy(body.get("enabled")) ? 1 : 0;
        if (id != null && id > 0) {
            db.update("UPDATE ALERT_MAINTENANCE_WINDOW SET INSTANCE_ID=?, TITLE=?, START_TIME=?, END_TIME=?, ENABLED=?, CREATED_BY=? WHERE WINDOW_ID=?",
                    instanceId, title, start, end, en, username, id);
        } else {
            db.insertReturningId("INSERT INTO ALERT_MAINTENANCE_WINDOW (INSTANCE_ID, TITLE, START_TIME, END_TIME, ENABLED, CREATED_BY) "
                            + "VALUES (?,?,?,?,?,?)", "WINDOW_ID", instanceId, title, start, end, en, username);
        }
    }

    public List<Map<String, Object>> listMaintenanceWindows() {
        try {
            return db.query("SELECT w.*, i.INSTANCE_NAME FROM ALERT_MAINTENANCE_WINDOW w "
                    + "LEFT JOIN CMDB_INSTANCE i ON i.INSTANCE_ID = w.INSTANCE_ID ORDER BY w.START_TIME DESC FETCH FIRST 100 ROWS ONLY");
        } catch (Exception e) {
            if (Db.isMissingTable(e)) {
                return List.of();
            }
            throw e;
        }
    }

    public boolean tablesReady() {
        try {
            db.query("SELECT 1 FROM ALERT_MAINTENANCE_SILENCE_LOG WHERE 1=0");
            return true;
        } catch (Exception e) {
            if (Db.isMissingTable(e)) {
                return false;
            }
            throw e instanceof RuntimeException re ? re : new RuntimeException(e);
        }
    }

    private record Window(Long instanceId, String title, Object start, Object end, String source) {
    }
}
