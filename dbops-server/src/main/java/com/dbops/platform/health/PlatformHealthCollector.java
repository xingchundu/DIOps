package com.dbops.platform.health;

import com.dbops.platform.PlatformProperties;
import com.dbops.common.Db;
import com.dbops.common.Values;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 平台自监控指标采集。
 * 修改者: dxc | 时间: 2026-11-12
 */
@Service
public class PlatformHealthCollector {

    private static final Logger log = LoggerFactory.getLogger(PlatformHealthCollector.class);

    private final Db db;
    private final PlatformProperties props;

    public PlatformHealthCollector(Db db, PlatformProperties props) {
        this.db = db;
        this.props = props;
    }

    public boolean tablesReady() {
        try {
            db.query("SELECT 1 FROM PLATFORM_HEALTH_SNAPSHOT WHERE 1=0");
            return true;
        } catch (Exception e) {
            if (Db.isMissingTable(e)) {
                return false;
            }
            throw e instanceof RuntimeException re ? re : new RuntimeException(e);
        }
    }

    public List<Map<String, Object>> collectAndPersist() {
        List<Map<String, Object>> metrics = new ArrayList<>();
        metrics.add(metricCollectSuccess());
        metrics.add(metricNotifyOutbox());
        metrics.add(metricBackupFail24h());
        metrics.add(metricSqlInsightOpen());
        if (tablesReady()) {
            for (Map<String, Object> m : metrics) {
                try {
                    db.update("INSERT INTO PLATFORM_HEALTH_SNAPSHOT (METRIC_KEY, METRIC_VALUE, UNIT, STATUS, DETAIL) VALUES (?,?,?,?,?)",
                            m.get("key"), m.get("value"), m.get("unit"), m.get("status"), m.get("detail"));
                } catch (Exception e) {
                    log.debug("[phase3-health] persist {}: {}", m.get("key"), e.getMessage());
                }
            }
        }
        return metrics;
    }

    public List<Map<String, Object>> latestMetrics() {
        if (!tablesReady()) {
            return List.of();
        }
        try {
            List<Map<String, Object>> rows = db.query(
                    "SELECT METRIC_KEY, METRIC_VALUE, UNIT, STATUS, DETAIL, COLLECTED_AT FROM ("
                            + "SELECT s.*, ROW_NUMBER() OVER (PARTITION BY METRIC_KEY ORDER BY COLLECTED_AT DESC) RN "
                            + "FROM PLATFORM_HEALTH_SNAPSHOT s WHERE COLLECTED_AT >= SYSTIMESTAMP - NUMTODSINTERVAL(2, 'HOUR')) "
                            + "WHERE RN = 1");
            if (!rows.isEmpty()) {
                List<Map<String, Object>> out = new ArrayList<>();
                for (Map<String, Object> r : rows) {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("key", r.get("METRIC_KEY"));
                    m.put("value", r.get("METRIC_VALUE"));
                    m.put("unit", r.get("UNIT"));
                    m.put("status", r.get("STATUS"));
                    m.put("detail", r.get("DETAIL"));
                    m.put("collectedAt", r.get("COLLECTED_AT"));
                    out.add(m);
                }
                return out;
            }
        } catch (Exception e) {
            if (!Db.isMissingTable(e)) {
                log.warn("[phase3-health] read latest: {}", e.getMessage());
            }
        }
        return List.of();
    }

    public List<Map<String, Object>> history(String metricKey, int hours) {
        int h = Math.max(1, Math.min(hours, 168));
        try {
            return db.query(
                    "SELECT METRIC_KEY, METRIC_VALUE, UNIT, STATUS, DETAIL, COLLECTED_AT FROM PLATFORM_HEALTH_SNAPSHOT "
                            + "WHERE METRIC_KEY=? AND COLLECTED_AT >= SYSTIMESTAMP - NUMTODSINTERVAL(?, 'HOUR') "
                            + "ORDER BY COLLECTED_AT ASC",
                    metricKey, h);
        } catch (Exception e) {
            if (Db.isMissingTable(e)) {
                return List.of();
            }
            throw e instanceof RuntimeException re ? re : new RuntimeException(e);
        }
    }

    private Map<String, Object> metricCollectSuccess() {
        long total = 0;
        long ok = 0;
        try {
            Map<String, Object> r = db.one(
                    "SELECT COUNT(*) TOTAL, SUM(CASE WHEN EXISTS ("
                            + "SELECT 1 FROM MONITOR_METRIC_SAMPLE m WHERE m.INSTANCE_ID = i.INSTANCE_ID "
                            + "AND m.COLLECTED_AT >= SYSTIMESTAMP - NUMTODSINTERVAL(15, 'MINUTE') AND NVL(m.REACHABLE,0)=1) "
                            + "THEN 1 ELSE 0 END) OK_CNT FROM CMDB_INSTANCE i WHERE NVL(i.STATUS,'UNKNOWN') <> 'STOPPED'");
            if (r != null) {
                total = Values.toLong(r.get("TOTAL"), 0);
                ok = Values.toLong(r.get("OK_CNT"), 0);
            }
        } catch (Exception e) {
            return row("collect_success_pct", 0, "%", "WARN", "采集成功率查询失败: " + Values.truncate(e.getMessage(), 200));
        }
        double pct = total == 0 ? 100.0 : Math.round(ok * 1000.0 / total) / 10.0;
        String st = pct >= props.collectWarnPct() ? "OK" : "WARN";
        return row("collect_success_pct", pct, "%", st,
                "近15分钟有有效样本的实例 " + ok + "/" + total);
    }

    private Map<String, Object> metricNotifyOutbox() {
        long pending = 0;
        try {
            Map<String, Object> r = db.one("SELECT COUNT(*) CNT FROM NOTIFY_OUTBOX WHERE STATUS IN ('PENDING','RETRY')");
            pending = r == null ? 0 : Values.toLong(r.get("CNT"), 0);
        } catch (Exception e) {
            if (Db.isMissingTable(e)) {
                return row("notify_outbox_pending", 0, "条", "OK", "阶段1外发表未迁移");
            }
            return row("notify_outbox_pending", 0, "条", "WARN", e.getMessage());
        }
        String st = pending <= props.outboxWarn() ? "OK" : "WARN";
        return row("notify_outbox_pending", pending, "条", st, "PENDING/RETRY 外发队列");
    }

    private Map<String, Object> metricBackupFail24h() {
        long fails = 0;
        try {
            Map<String, Object> r = db.one(
                    "SELECT COUNT(*) CNT FROM BACKUP_RECORD_PRO WHERE STATUS='FAILED' AND CREATED_AT >= SYSTIMESTAMP - NUMTODSINTERVAL(1, 'DAY')");
            fails = r == null ? 0 : Values.toLong(r.get("CNT"), 0);
        } catch (Exception e) {
            if (Db.isMissingTable(e)) {
                return row("backup_fail_24h", 0, "次", "OK", "BACKUP_RECORD_PRO 不存在");
            }
            return row("backup_fail_24h", 0, "次", "WARN", e.getMessage());
        }
        String st = fails <= props.backupFailWarn() ? "OK" : "WARN";
        return row("backup_fail_24h", fails, "次", st, "近24小时备份失败");
    }

    private Map<String, Object> metricSqlInsightOpen() {
        long open = 0;
        try {
            Map<String, Object> p = db.one("SELECT COUNT(*) CNT FROM DI_SQL_PROBLEM WHERE STATUS='OPEN'");
            Map<String, Object> a = db.one("SELECT COUNT(*) CNT FROM DI_SQL_ANOMALY WHERE STATUS='OPEN'");
            open = Values.toLong(p == null ? 0 : p.get("CNT"), 0) + Values.toLong(a == null ? 0 : a.get("CNT"), 0);
        } catch (Exception e) {
            if (Db.isMissingTable(e)) {
                return row("sqlinsight_open_count", 0, "条", "OK", "SQL洞察未迁移");
            }
            return row("sqlinsight_open_count", 0, "条", "WARN", e.getMessage());
        }
        String st = open <= props.sqlInsightOpenWarn() ? "OK" : "WARN";
        return row("sqlinsight_open_count", open, "条", st, "OPEN 问题+波动");
    }

    private static Map<String, Object> row(String key, Object value, String unit, String status, String detail) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("key", key);
        m.put("value", value);
        m.put("unit", unit);
        m.put("status", status);
        m.put("detail", detail);
        return m;
    }

}
