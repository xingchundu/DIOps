package com.dbops.sqlinsight.plan;

import com.dbops.common.Db;
import com.dbops.common.Values;
import com.dbops.sqlinsight.store.Json;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 优化复测跟踪：SQL 优化上线前后的分钟窗口指标对比，关联 SQL 评审工单。
 * <pre>
 * PENDING   已登记（通常由优化工单自动登记），等待优化上线
 * WATCHING  已上线，持续观察；优化前 = 上线前 24 小时快照，优化后 = 上线至今
 * DONE      已出结论（人工结束，或观察超过 sqlinsight.retest.auto_finish_hours 自动结束）
 * CANCELLED 取消
 * </pre>
 * 工单通过（APPROVED）后，每小时自动把关联的 PENDING 复测转为 WATCHING（以工单执行时间 / 审核时间为上线时刻）。
 */
@Service
public class RetestService {

    private static final Logger log = LoggerFactory.getLogger(RetestService.class);
    public static final int BEFORE_HOURS = 24;

    private final Db db;
    private final PlanCaptureService plans;

    public RetestService(Db db, PlanCaptureService plans) {
        this.db = db;
        this.plans = plans;
    }

    /** 窗口 [from, to) 内该 SQL 在该实例上的指标快照 */
    public Map<String, Object> snapshot(long instanceId, long assetId, Timestamp from, Timestamp to) {
        Map<String, Object> m = db.one("SELECT NVL(SUM(D_EXEC), 0) EXECS, ROUND(SUM(D_ELAPSED_MS) / NULLIF(SUM(D_EXEC), 0), 2) AVG_MS, "
                + "ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY AVG_ELAPSED_MS), 2) P95_MS, ROUND(SUM(D_CPU_MS) / NULLIF(SUM(D_EXEC), 0), 2) CPU_MS, "
                + "ROUND(SUM(D_LOGICAL_READS) / NULLIF(SUM(D_EXEC), 0), 0) LR, ROUND(SUM(D_PHYSICAL_READS) / NULLIF(SUM(D_EXEC), 0), 0) PR, "
                + "ROUND(NVL(SUM(D_ELAPSED_MS), 0) / 1000, 1) DB_TIME_SEC, COUNT(*) WINDOWS, COUNT(DISTINCT PLAN_HASH) PLANS "
                + "FROM DI_SQL_STATS_MIN WHERE ASSET_ID = ? AND INSTANCE_ID = ? AND WINDOW_START >= ? AND WINDOW_START < ? AND D_EXEC > 0",
                assetId, instanceId, from, to);
        Map<String, Object> out = new LinkedHashMap<>(m == null ? Map.of() : m);
        Map<String, Object> top = db.one("SELECT PLAN_HASH FROM (SELECT PLAN_HASH FROM DI_SQL_STATS_MIN WHERE ASSET_ID = ? AND INSTANCE_ID = ? AND WINDOW_START >= ? "
                + "AND WINDOW_START < ? AND D_EXEC > 0 GROUP BY PLAN_HASH ORDER BY SUM(D_EXEC) DESC) WHERE ROWNUM = 1", assetId, instanceId, from, to);
        out.put("PLAN_HASH", top == null ? null : top.get("PLAN_HASH"));
        out.put("FROM", from.toString());
        out.put("TO", to.toString());
        return out;
    }

    public Long createPending(long instanceId, long assetId, Long ticketId, String note, int minHours, String user) {
        Map<String, Object> dup = db.one("SELECT RETEST_ID FROM DI_SQL_RETEST WHERE INSTANCE_ID=? AND ASSET_ID=? AND STATUS IN ('PENDING','WATCHING') "
                + "AND NVL(TICKET_ID, -1) = NVL(?, -1)", instanceId, assetId, ticketId);
        if (dup != null) {
            return Values.toLong(dup.get("RETEST_ID"));
        }
        return db.insertReturningId("INSERT INTO DI_SQL_RETEST (INSTANCE_ID, ASSET_ID, TICKET_ID, STATUS, NOTE, MIN_HOURS, CREATED_BY) VALUES (?, ?, ?, 'PENDING', ?, ?, ?)",
                "RETEST_ID", instanceId, assetId, ticketId, Values.truncate(note, 512), Math.max(1, Math.min(minHours, 168)), Values.truncate(user, 64));
    }

    /** 开始观察：at 为优化上线时刻（空 = 现在，不能晚于现在） */
    public boolean start(long retestId, Timestamp at) {
        Map<String, Object> r = db.one("SELECT * FROM DI_SQL_RETEST WHERE RETEST_ID=? AND STATUS='PENDING'", retestId);
        if (r == null) {
            return false;
        }
        long now = System.currentTimeMillis();
        Timestamp t = at == null || at.getTime() > now ? new Timestamp(now) : at;
        long inst = Values.toLong(r.get("INSTANCE_ID"), 0), asset = Values.toLong(r.get("ASSET_ID"), 0);
        Map<String, Object> before = snapshot(inst, asset, new Timestamp(t.getTime() - BEFORE_HOURS * 3600_000L), t);
        String hash = Values.str(before.get("PLAN_HASH"));
        PlanCaptureService.Plan p = plans.capture(inst, asset, hash);
        before.put("planSource", p == null ? null : p.source);
        db.update("UPDATE DI_SQL_RETEST SET STATUS='WATCHING', STARTED_AT=?, BEFORE_JSON=?, BEFORE_PLAN_HASH=? WHERE RETEST_ID=?",
                t, Json.write(before), p == null ? hash : p.hash, retestId);
        return true;
    }

    /** 实时（WATCHING）或冻结（DONE）的视图，含前后快照、结论、观察时长 */
    public Map<String, Object> view(Map<String, Object> row) {
        Map<String, Object> v = new LinkedHashMap<>();
        for (String k : List.of("RETEST_ID", "INSTANCE_ID", "ASSET_ID", "TICKET_ID", "STATUS", "NOTE", "MIN_HOURS", "STARTED_AT", "BEFORE_PLAN_HASH",
                "AFTER_PLAN_HASH", "VERDICT", "VERDICT_TEXT", "CREATED_BY", "CREATED_AT", "FINISHED_AT", "INSTANCE_NAME", "SQL_TEXT", "NATIVE_SQL_ID", "TICKET_STATUS")) {
            if (row.containsKey(k)) {
                v.put(k, row.get(k));
            }
        }
        String status = Values.str(row.get("STATUS"), "");
        Map<String, Object> before = Json.map(Values.str(row.get("BEFORE_JSON")));
        v.put("before", before);
        if ("WATCHING".equals(status) && row.get("STARTED_AT") instanceof Timestamp st) {
            long inst = Values.toLong(row.get("INSTANCE_ID"), 0), asset = Values.toLong(row.get("ASSET_ID"), 0);
            Timestamp now = new Timestamp(System.currentTimeMillis());
            Map<String, Object> after = snapshot(inst, asset, st, now);
            double hours = (now.getTime() - st.getTime()) / 3600_000.0;
            Map<String, Object> ev = RetestVerdict.evaluate(before, after);
            v.put("after", after);
            v.put("liveVerdict", ev.get("verdict"));
            v.put("liveText", ev.get("text"));
            v.put("ratio", ev.get("ratio"));
            v.put("observedHours", Math.round(hours * 10) / 10.0);
            v.put("enough", hours >= Values.toLong(row.get("MIN_HOURS"), 6));
        } else {
            Map<String, Object> after = Json.map(Values.str(row.get("AFTER_JSON")));
            v.put("after", after);
            Object diff = after.get("planDiff");
            if (diff != null) {
                v.put("planDiff", diff);
            }
        }
        return v;
    }

    /** 结束观察并冻结结论；同时取优化后计划，对比访问路径 */
    public Map<String, Object> finish(long retestId) {
        Map<String, Object> r = db.one("SELECT * FROM DI_SQL_RETEST WHERE RETEST_ID=? AND STATUS='WATCHING'", retestId);
        if (r == null || !(r.get("STARTED_AT") instanceof Timestamp st)) {
            return null;
        }
        long inst = Values.toLong(r.get("INSTANCE_ID"), 0), asset = Values.toLong(r.get("ASSET_ID"), 0);
        Timestamp now = new Timestamp(System.currentTimeMillis());
        Map<String, Object> before = Json.map(Values.str(r.get("BEFORE_JSON")));
        Map<String, Object> after = snapshot(inst, asset, st, now);
        Map<String, Object> ev = RetestVerdict.evaluate(before, after);
        String afterHash = Values.str(after.get("PLAN_HASH"));
        PlanCaptureService.Plan ap = plans.capture(inst, asset, afterHash);
        String beforeHash = Values.str(r.get("BEFORE_PLAN_HASH"));
        PlanCaptureService.Plan bp = beforeHash == null ? null : plans.stored(inst, asset, beforeHash);
        if (ap != null && bp != null && bp.text != null) {
            after.put("planDiff", PlanDiff.compare(bp.text, ap.text));
            after.put("planSource", ap.source);
        } else {
            after.put("planDiff", Map.of("parsed", false, "changed", false, "summary", "优化前或优化后的计划文本未能留存（权限不足或已被清除），无法对比访问路径"));
        }
        db.update("UPDATE DI_SQL_RETEST SET STATUS='DONE', AFTER_JSON=?, AFTER_PLAN_HASH=?, VERDICT=?, VERDICT_TEXT=?, FINISHED_AT=SYSTIMESTAMP WHERE RETEST_ID=?",
                Json.write(after), ap == null ? afterHash : ap.hash, ev.get("verdict"), Values.truncate(Values.str(ev.get("text")), 500), retestId);
        Map<String, Object> out = new LinkedHashMap<>(ev);
        out.put("after", after);
        return out;
    }

    /** 关联工单已通过 → 开始观察 */
    public int syncTickets() {
        int n = 0;
        List<Map<String, Object>> rows = db.query("SELECT r.RETEST_ID, NVL(t.EXECUTED_AT, t.REVIEWED_AT) AT FROM DI_SQL_RETEST r JOIN SQL_REVIEW_TICKET t ON t.TICKET_ID = r.TICKET_ID "
                + "WHERE r.STATUS = 'PENDING' AND t.STATUS = 'APPROVED'");
        for (Map<String, Object> r : rows) {
            try {
                if (start(Values.toLong(r.get("RETEST_ID"), 0), r.get("AT") instanceof Timestamp ts ? ts : null)) {
                    n++;
                }
            } catch (Exception e) {
                log.warn("[sqlinsight] retest start {}: {}", r.get("RETEST_ID"), e.getMessage());
            }
        }
        db.updateQuietly("UPDATE DI_SQL_RETEST r SET STATUS='CANCELLED', FINISHED_AT=SYSTIMESTAMP, VERDICT_TEXT='关联工单已被拒绝或取消' WHERE r.STATUS='PENDING' AND r.TICKET_ID IS NOT NULL "
                + "AND EXISTS (SELECT 1 FROM SQL_REVIEW_TICKET t WHERE t.TICKET_ID = r.TICKET_ID AND t.STATUS IN ('REJECTED','CANCELLED'))");
        return n;
    }

    /** 观察超过 maxHours 自动出结论 */
    public int autoFinish(int maxHours) {
        int n = 0;
        List<Map<String, Object>> ids = db.query("SELECT RETEST_ID FROM DI_SQL_RETEST WHERE STATUS='WATCHING' AND STARTED_AT < SYSTIMESTAMP - NUMTODSINTERVAL(?, 'HOUR')",
                Math.max(1, maxHours));
        for (Map<String, Object> r : ids) {
            try {
                if (finish(Values.toLong(r.get("RETEST_ID"), 0)) != null) {
                    n++;
                }
            } catch (Exception e) {
                log.warn("[sqlinsight] retest finish {}: {}", r.get("RETEST_ID"), e.getMessage());
            }
        }
        return n;
    }

    public List<Map<String, Object>> list(Long instanceId, Long assetId, String status, int limit) {
        List<Object> args = new ArrayList<>();
        StringBuilder w = new StringBuilder("1=1");
        if (instanceId != null) {
            w.append(" AND r.INSTANCE_ID=?");
            args.add(instanceId);
        }
        if (assetId != null) {
            w.append(" AND r.ASSET_ID=?");
            args.add(assetId);
        }
        if (status != null && !status.isBlank() && !"ALL".equalsIgnoreCase(status)) {
            w.append(" AND r.STATUS=?");
            args.add(status.toUpperCase(java.util.Locale.ROOT));
        }
        List<Map<String, Object>> rows = db.query("SELECT * FROM (SELECT r.*, i.INSTANCE_NAME, DBMS_LOB.SUBSTR(a.SAMPLE_SQL, 200, 1) SQL_TEXT, "
                + "(SELECT MAX(src.NATIVE_ID) KEEP (DENSE_RANK LAST ORDER BY src.LAST_SEEN) FROM DI_SQL_ASSET_SOURCE src WHERE src.ASSET_ID = r.ASSET_ID AND src.INSTANCE_ID = r.INSTANCE_ID) NATIVE_SQL_ID, "
                + "(SELECT t.STATUS FROM SQL_REVIEW_TICKET t WHERE t.TICKET_ID = r.TICKET_ID) TICKET_STATUS "
                + "FROM DI_SQL_RETEST r LEFT JOIN CMDB_INSTANCE i ON i.INSTANCE_ID = r.INSTANCE_ID LEFT JOIN DI_SQL_ASSET a ON a.ASSET_ID = r.ASSET_ID WHERE " + w
                + " ORDER BY r.RETEST_ID DESC) WHERE ROWNUM <= " + Math.max(1, Math.min(limit, 200)), args);
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map<String, Object> r : rows) {
            out.add(view(r));
        }
        return out;
    }
}
