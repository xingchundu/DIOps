package com.dbops.monitor;

import com.dbops.alert.AlertPolicyService;
import com.dbops.common.Db;
import com.dbops.common.R;
import com.dbops.common.Values;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 集群维度：RAC / 磐维集群 可达成员数 vs EXPECTED_MEMBER_COUNT（对应 Node monitorClusterRollup.js）。
 * <p>
 * [fix] 已有告警判重用 CONTENT LIKE '%CLUSTER_ID=1%'，会误匹配 CLUSTER_ID=10/11…，导致这些集群的告警被吞；
 *       且只看 OPEN，确认后每轮又重复插入。
 * [fix] 集群恢复后告警不会关闭：现在可达数恢复时自动 RESOLVED。
 * [改进] 成员最近样本由 N 次查询改为一次查询。
 */
@Service
public class ClusterRollupService {

    private static final Logger log = LoggerFactory.getLogger(ClusterRollupService.class);
    static final String RULE_NAME = "RAC集群节点数不足";

    private final Db db;
    private final AlertPolicyService policies;

    public ClusterRollupService(Db db, AlertPolicyService policies) {
        this.db = db;
        this.policies = policies;
    }

    static String marker(Object clusterId) {
        return "CLUSTER_ID=" + clusterId + " ";
    }

    public List<Map<String, Object>> run() {
        List<Map<String, Object>> results = new ArrayList<>();
        List<Map<String, Object>> clusters;
        try {
            clusters = db.query("SELECT c.CLUSTER_ID, c.CLUSTER_NAME, c.EXPECTED_MEMBER_COUNT, c.CLUSTER_TYPE FROM CMDB_CLUSTER c "
                    + "WHERE c.EXPECTED_MEMBER_COUNT IS NOT NULL AND c.EXPECTED_MEMBER_COUNT > 0");
        } catch (Exception e) {
            if (Db.isMissingColumn(e) || Db.isMissingTable(e)) {
                return results;
            }
            throw e;
        }
        if (clusters.isEmpty()) {
            return results;
        }
        Map<String, Object> rule = db.one("SELECT RULE_ID FROM ALERT_RULE WHERE RULE_NAME = ?", RULE_NAME);
        Object ruleId = rule == null ? null : rule.get("RULE_ID");
        for (Map<String, Object> cl : clusters) {
            Object cid = cl.get("CLUSTER_ID");
            long reachable = db.count("SELECT COUNT(*) FROM CMDB_CLUSTER_MEMBER m JOIN ("
                    + "SELECT INSTANCE_ID, REACHABLE, ROW_NUMBER() OVER (PARTITION BY INSTANCE_ID ORDER BY COLLECTED_AT DESC) AS RN "
                    + "FROM MONITOR_METRIC_SAMPLE WHERE COLLECTED_AT >= SYSTIMESTAMP - INTERVAL '1' DAY) s "
                    + "ON s.INSTANCE_ID = m.INSTANCE_ID AND s.RN = 1 WHERE m.CLUSTER_ID = ? AND s.REACHABLE = 1", cid);
            long expected = Values.toLong(cl.get("EXPECTED_MEMBER_COUNT"), 0);
            boolean ok = reachable >= expected;
            results.add(R.map("clusterId", cid, "clusterName", cl.get("CLUSTER_NAME"), "reachable", reachable, "expected", expected, "ok", ok));
            String like = marker(cid) + "%";
            List<Map<String, Object>> active = db.query("SELECT ALERT_ID FROM ALERT_RECORD WHERE RULE_NAME = ? "
                    + "AND STATUS IN ('OPEN','ACKNOWLEDGED','SILENCED','SUPPRESSED') AND CONTENT LIKE ?", RULE_NAME, like);
            if (ok) {
                for (Map<String, Object> a : active) {
                    int n = db.update("UPDATE ALERT_RECORD SET STATUS='RESOLVED', RESOLVE_TIME=SYSTIMESTAMP, RESOLVE_BY='SYSTEM', "
                            + "DETAIL=? WHERE ALERT_ID=? AND STATUS <> 'RESOLVED'", "集群可达成员已恢复 " + reachable + "/" + expected, a.get("ALERT_ID"));
                    if (n > 0) {
                        policies.releaseSuppressedChildren(a.get("ALERT_ID"));
                    }
                }
                continue;
            }
            if (!active.isEmpty()) {
                continue;
            }
            String content = marker(cid) + cl.get("CLUSTER_NAME") + ": 可达成员 " + reachable + "/" + expected;
            try {
                Long alertId = db.insertReturningId("INSERT INTO ALERT_RECORD (RULE_ID, RULE_NAME, INSTANCE_ID, INSTANCE_NAME, SEVERITY, CONTENT, STATUS, TRIGGER_TIME) "
                                + "VALUES (?, ?, NULL, ?, 'P1', ?, 'OPEN', SYSTIMESTAMP)", "ALERT_ID",
                        ruleId, RULE_NAME, cl.get("CLUSTER_NAME"), Values.truncate(content, 1024));
                if (alertId != null) {
                    policies.applySilenceById(alertId);
                }
            } catch (Exception e) {
                log.warn("[cluster-rollup] insert alert {}: {}", cid, e.getMessage());
            }
        }
        return results;
    }
}
