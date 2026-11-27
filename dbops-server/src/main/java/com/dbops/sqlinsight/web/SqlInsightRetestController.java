package com.dbops.sqlinsight.web;

import com.dbops.common.Db;
import com.dbops.common.R;
import com.dbops.common.Values;
import com.dbops.security.CurrentUser;
import com.dbops.service.AuditService;
import com.dbops.sqlinsight.plan.PlanCaptureService;
import com.dbops.sqlinsight.plan.RetestService;
import com.dbops.sqlinsight.store.Json;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.sql.Timestamp;
import java.util.Map;

/**
 * 优化复测跟踪 + 计划访问路径对比。
 * <pre>
 * GET  /api/sql-insight/retests                       列表（含观察中的实时对比结论）
 * POST /api/sql-insight/retests                       登记 {instanceId, assetId, ticketId?, note?, minHours?, startNow?}
 * POST /api/sql-insight/retests/{id}/start            优化已上线，开始观察 {at?: 上线时间 ISO-8601，默认现在}
 * POST /api/sql-insight/retests/{id}/finish           结束观察并冻结结论（含优化前后访问路径对比）
 * POST /api/sql-insight/retests/{id}/cancel
 * GET  /api/sql-insight/retests/{id}/plans            优化前 / 后计划文本与访问路径差异
 * GET  /api/sql-insight/plan-changes/compare          两个 plan hash 的访问路径对比（Oracle）
 * </pre>
 */
@RestController
@RequestMapping("/api/sql-insight")
public class SqlInsightRetestController {

    private final Db db;
    private final RetestService retests;
    private final PlanCaptureService plans;
    private final AuditService audit;

    public SqlInsightRetestController(Db db, RetestService retests, PlanCaptureService plans, AuditService audit) {
        this.db = db;
        this.retests = retests;
        this.plans = plans;
        this.audit = audit;
    }

    @GetMapping("/retests")
    public Map<String, Object> list(@RequestParam(required = false) Long instanceId, @RequestParam(required = false) Long assetId,
                                    @RequestParam(required = false, defaultValue = "ALL") String status) {
        retests.syncTickets();   // 打开页面时顺带同步一次工单状态，不必等整点任务
        return R.ok(R.map("list", retests.list(instanceId, assetId, status, 100)));
    }

    @PostMapping("/retests")
    public Map<String, Object> create(CurrentUser u, @RequestBody Map<String, Object> b) {
        u.require("ADMIN", "DBA", "OPS");
        Long inst = Values.toLong(b.get("instanceId"));
        Long asset = Values.toLong(b.get("assetId"));
        if (inst == null || asset == null) {
            return R.badRequest("instanceId 与 assetId 必填");
        }
        if (db.one("SELECT 1 X FROM DI_SQL_ASSET WHERE ASSET_ID=?", asset) == null) {
            return R.notFound("SQL 资产不存在");
        }
        int minHours = (int) Values.toLong(b.get("minHours"), 6);
        Long id = retests.createPending(inst, asset, Values.toLong(b.get("ticketId")), Values.str(b.get("note")), minHours, u.username());
        if (id == null) {
            return R.fail(500, "写入失败，请确认已执行 sql/migration_sql_insight.sql（DI_SQL_RETEST）");
        }
        boolean started = false;
        if (b.get("startNow") == null || Values.truthy(b.get("startNow"))) {
            started = retests.start(id, null);
        }
        audit.log(u, "SQLINSIGHT_RETEST_CREATE", "DI_SQL_RETEST", String.valueOf(id), "SUCCESS", Json.write(b));
        return R.ok(R.map("retestId", id, "started", started), started ? "已开始观察：以前 24 小时为优化前基线" : "已登记，等待优化上线");
    }

    @PostMapping("/retests/{id}/start")
    public Map<String, Object> start(CurrentUser u, @PathVariable long id, @RequestBody(required = false) Map<String, Object> b) {
        u.require("ADMIN", "DBA", "OPS");
        Timestamp at = null;
        String s = b == null ? null : Values.str(b.get("at"));
        if (s != null && !s.isBlank()) {
            try {
                at = Timestamp.from(java.time.OffsetDateTime.parse(s).toInstant());
            } catch (Exception e) {
                try {
                    at = Timestamp.valueOf(java.time.LocalDateTime.parse(s.replace(' ', 'T')));
                } catch (Exception e2) {
                    return R.badRequest("上线时间格式应为 ISO-8601，如 2026-11-24T09:30:00");
                }
            }
        }
        if (!retests.start(id, at)) {
            return R.badRequest("只有「待上线」状态的复测可以开始观察");
        }
        audit.log(u, "SQLINSIGHT_RETEST_START", "DI_SQL_RETEST", String.valueOf(id), "SUCCESS", s);
        return R.msg("已开始观察");
    }

    @PostMapping("/retests/{id}/finish")
    public Map<String, Object> finish(CurrentUser u, @PathVariable long id) {
        u.require("ADMIN", "DBA", "OPS");
        Map<String, Object> r = retests.finish(id);
        if (r == null) {
            return R.badRequest("只有「观察中」的复测可以结束");
        }
        audit.log(u, "SQLINSIGHT_RETEST_FINISH", "DI_SQL_RETEST", String.valueOf(id), "SUCCESS", String.valueOf(r.get("verdict")));
        return R.ok(r, "已出结论");
    }

    @PostMapping("/retests/{id}/cancel")
    public Map<String, Object> cancel(CurrentUser u, @PathVariable long id) {
        u.require("ADMIN", "DBA", "OPS");
        int n = db.update("UPDATE DI_SQL_RETEST SET STATUS='CANCELLED', FINISHED_AT=SYSTIMESTAMP WHERE RETEST_ID=? AND STATUS IN ('PENDING','WATCHING')", id);
        if (n == 0) {
            return R.badRequest("该复测已结束或不存在");
        }
        audit.log(u, "SQLINSIGHT_RETEST_CANCEL", "DI_SQL_RETEST", String.valueOf(id), "SUCCESS", null);
        return R.msg("已取消");
    }

    @GetMapping("/retests/{id}/plans")
    public Map<String, Object> retestPlans(@PathVariable long id) {
        Map<String, Object> r = db.one("SELECT INSTANCE_ID, ASSET_ID, BEFORE_PLAN_HASH, AFTER_PLAN_HASH, AFTER_JSON, STATUS FROM DI_SQL_RETEST WHERE RETEST_ID=?", id);
        if (r == null) {
            return R.notFound("复测不存在");
        }
        long inst = Values.toLong(r.get("INSTANCE_ID"), 0), asset = Values.toLong(r.get("ASSET_ID"), 0);
        String bh = Values.str(r.get("BEFORE_PLAN_HASH")), ah = Values.str(r.get("AFTER_PLAN_HASH"));
        PlanCaptureService.Plan b = bh == null ? null : plans.stored(inst, asset, bh);
        PlanCaptureService.Plan a = ah == null ? null : plans.stored(inst, asset, ah);
        if (a == null && "WATCHING".equals(String.valueOf(r.get("STATUS")))) {
            a = plans.capture(inst, asset, null);   // 观察中：取当前计划做即时对比
        }
        Map<String, Object> diff = com.dbops.sqlinsight.plan.PlanDiff.compare(b == null ? null : b.text, a == null ? null : a.text);
        diff.put("beforePlan", b == null ? null : b.text);
        diff.put("afterPlan", a == null ? null : a.text);
        diff.put("beforeSource", b == null ? null : b.source);
        diff.put("afterSource", a == null ? null : a.source);
        diff.put("beforeHash", bh);
        diff.put("afterHash", a == null ? ah : a.hash);
        return R.ok(diff);
    }

    @GetMapping("/plan-changes/compare")
    public Map<String, Object> compare(@RequestParam long instanceId, @RequestParam long assetId, @RequestParam String oldHash, @RequestParam String newHash) {
        return R.ok(plans.compare(instanceId, assetId, oldHash, newHash));
    }
}
