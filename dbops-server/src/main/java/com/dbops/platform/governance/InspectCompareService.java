package com.dbops.platform.governance;

import com.dbops.common.Db;
import com.dbops.common.Values;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 巡检报告环比：本期 vs 上期 issue 差异。
 * 修改者: dxc | 时间: 2026-11-12
 */
@Service
public class InspectCompareService {

    private final Db db;

    public InspectCompareService(Db db) {
        this.db = db;
    }

    public Map<String, Object> compare(long baseReportId, Long prevReportId) {
        Map<String, Object> base = db.one(
                "SELECT REPORT_ID, TASK_ID, INSTANCE_ID, REPORT_TYPE, OVERALL_STATUS, OVERALL_SCORE, CREATED_AT "
                        + "FROM INSPECT_REPORT WHERE REPORT_ID=?", baseReportId);
        if (base == null) {
            throw new IllegalArgumentException("报告不存在: " + baseReportId);
        }
        Map<String, Object> prev;
        if (prevReportId != null && prevReportId > 0) {
            prev = db.one("SELECT REPORT_ID, TASK_ID, INSTANCE_ID, REPORT_TYPE, OVERALL_STATUS, OVERALL_SCORE, CREATED_AT "
                    + "FROM INSPECT_REPORT WHERE REPORT_ID=?", prevReportId);
        } else {
            long inst = Values.toLong(base.get("INSTANCE_ID"), 0);
            String type = Values.str(base.get("REPORT_TYPE"));
            prev = db.one(
                    "SELECT REPORT_ID, TASK_ID, INSTANCE_ID, REPORT_TYPE, OVERALL_STATUS, OVERALL_SCORE, CREATED_AT "
                            + "FROM INSPECT_REPORT WHERE INSTANCE_ID=? AND REPORT_TYPE=? AND REPORT_ID < ? "
                            + "ORDER BY REPORT_ID DESC FETCH FIRST 1 ROWS ONLY", inst, type, baseReportId);
        }
        List<Map<String, Object>> baseIssues = issues(baseReportId);
        List<Map<String, Object>> prevIssues = prev == null ? List.of() : issues(Values.toLong(prev.get("REPORT_ID"), 0));
        Map<String, Map<String, Object>> prevMap = index(prevIssues);
        Map<String, Map<String, Object>> baseMap = index(baseIssues);
        List<Map<String, Object>> added = new ArrayList<>();
        List<Map<String, Object>> removed = new ArrayList<>();
        List<Map<String, Object>> persisted = new ArrayList<>();
        for (Map.Entry<String, Map<String, Object>> e : baseMap.entrySet()) {
            if (!prevMap.containsKey(e.getKey())) {
                added.add(e.getValue());
            } else {
                Map<String, Object> row = new LinkedHashMap<>(e.getValue());
                row.put("prevSeverity", prevMap.get(e.getKey()).get("SEVERITY"));
                persisted.add(row);
            }
        }
        for (Map.Entry<String, Map<String, Object>> e : prevMap.entrySet()) {
            if (!baseMap.containsKey(e.getKey())) {
                removed.add(e.getValue());
            }
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("base", base);
        out.put("prev", prev);
        out.put("added", added);
        out.put("removed", removed);
        out.put("persisted", persisted);
        out.put("summary", Map.of(
                "added", added.size(),
                "removed", removed.size(),
                "persisted", persisted.size()));
        return out;
    }

    private List<Map<String, Object>> issues(long reportId) {
        try {
            return db.query("SELECT ISSUE_ID, CATEGORY, SEVERITY, TITLE, DESCRIPTION, METRIC_KEY FROM INSPECT_ISSUE WHERE REPORT_ID=?",
                    reportId);
        } catch (Exception e) {
            if (Db.isMissingTable(e)) {
                return List.of();
            }
            throw e;
        }
    }

    private static Map<String, Map<String, Object>> index(List<Map<String, Object>> issues) {
        Map<String, Map<String, Object>> m = new HashMap<>();
        for (Map<String, Object> i : issues) {
            String key = Values.str(i.get("CATEGORY"), "") + "|" + Values.str(i.get("TITLE"), "");
            m.put(key, i);
        }
        return m;
    }
}
