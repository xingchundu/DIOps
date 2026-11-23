package com.dbops.sqlinsight.web;

import com.dbops.common.Db;
import com.dbops.common.R;
import com.dbops.common.Values;
import com.dbops.monitor.TargetConnector;
import com.dbops.security.CurrentUser;
import com.dbops.sqlinsight.ast.SqlAstService;
import com.dbops.sqlinsight.audit.ExplainService;
import com.dbops.sqlinsight.audit.SqlAuditService;
import com.dbops.sqlinsight.collect.SqlCollectService;
import com.dbops.sqlinsight.collect.SlowSqlService;
import com.dbops.common.BizException;
import java.sql.Timestamp;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * /api/sql —— 原 Node routes/sql.js 的同名接口（已删除），前端 sqlApi 不用改：
 * <ul>
 *   <li>GET /slow：读 SQL_SLOW_SUMMARY 慢 SQL 快照（按采集时间存放，可按时间范围 / 批次查询）</li>
 *   <li>POST /explain：危险语句识别改为 AST（原正则可被注释/多语句绕过），执行计划支持 5 库</li>
 *   <li>POST /optimize：改为统一审核引擎（原 8 条正则）</li>
 *   <li>POST /capture/:id：立即采集慢 SQL（7 种库；原仅 Oracle、且 MERGE 有绑定 bug）</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/sql")
public class SqlCompatController {

    private final Db db;
    private final SqlAstService ast;
    private final ExplainService explain;
    private final SqlAuditService auditSvc;
    private final SqlCollectService collect;
    private final SlowSqlService slowSql;
    private final TargetConnector connector;

    public SqlCompatController(Db db, SqlAstService ast, ExplainService explain, SqlAuditService auditSvc, SqlCollectService collect,
                               TargetConnector connector, SlowSqlService slowSql) {
        this.slowSql = slowSql;
        this.db = db;
        this.ast = ast;
        this.explain = explain;
        this.auditSvc = auditSvc;
        this.collect = collect;
        this.connector = connector;
    }

    /**
     * 慢 SQL 快照（SQL_SLOW_SUMMARY，按采集时间存放）。
     * 默认最近 24 小时；from/to 支持毫秒时间戳或 yyyy-MM-dd HH:mm[:ss]；batch 指定某一次采集。
     */
    @GetMapping("/slow")
    public Map<String, Object> slow(@RequestParam(required = false) Long instanceId, @RequestParam(required = false) String from,
                                    @RequestParam(required = false) String to, @RequestParam(required = false) String keyword,
                                    @RequestParam(required = false) Double minAvgMs, @RequestParam(required = false) String batch,
                                    @RequestParam(required = false) Long assetId,
                                    @RequestParam(required = false, defaultValue = "1") String page,
                                    @RequestParam(required = false, defaultValue = "20") String size) {
        Timestamp[] range = range(from, to, 24);
        return R.ok(slowSql.list(instanceId, range[0], range[1], keyword, minAvgMs, batch, assetId, page, size));
    }

    /** 采集批次时间轴 */
    @GetMapping("/slow/batches")
    public Map<String, Object> batches(@RequestParam(required = false) Long instanceId, @RequestParam(required = false) String from,
                                       @RequestParam(required = false) String to) {
        Timestamp[] range = range(from, to, 24 * 7);
        return R.ok(slowSql.batches(instanceId, range[0], range[1]));
    }

    /** 单条快照详情（含完整 SQL 文本） */
    @GetMapping("/slow/{rowId}")
    public Map<String, Object> slowRow(@PathVariable long rowId) {
        return R.ok(slowSql.row(rowId));
    }

    /** 同一条 SQL 在历次快照中的指标变化 */
    @GetMapping("/slow/{rowId}/history")
    public Map<String, Object> slowHistory(@PathVariable long rowId, @RequestParam(required = false, defaultValue = "7") int days) {
        return R.ok(slowSql.history(rowId, days));
    }

    static Timestamp[] range(String from, String to, int defaultHours) {
        long now = System.currentTimeMillis();
        Timestamp t = parseTs(to, now);
        Timestamp f = parseTs(from, t.getTime() - defaultHours * 3600_000L);
        if (f.after(t)) {
            throw BizException.badRequest("开始时间不能晚于结束时间");
        }
        return new Timestamp[]{f, t};
    }

    static Timestamp parseTs(String v, long def) {
        if (v == null || v.isBlank()) {
            return new Timestamp(def);
        }
        Long ms = Values.toStrictLong(v);
        if (ms != null) {
            return new Timestamp(ms);
        }
        try {
            String s = v.trim().replace('T', ' ');
            if (s.length() == 10) {
                s += " 00:00:00";
            } else if (s.length() == 16) {
                s += ":00";
            }
            return Timestamp.valueOf(s.length() > 19 ? s.substring(0, 19) : s);
        } catch (Exception e) {
            throw BizException.badRequest("时间格式不正确: " + v);
        }
    }

    @PostMapping("/explain")
    public Map<String, Object> explain(CurrentUser u, @RequestBody Map<String, Object> b) {
        u.require("ADMIN", "DBA", "OPS");
        Long instanceId = Values.toLong(b.get("instanceId"));
        String sql = Values.str(b.get("sqlText"), "");
        if (instanceId == null || sql.isBlank()) {
            return R.badRequest("instanceId和sqlText不能为空");
        }
        if (!Values.truthy(b.get("allowDangerous"))) {
            String danger = ast.dangerousType(sql, connector.fetch(instanceId).dbType());
            if (danger != null) {
                return R.fail(403, "安全拦截: 检测到 " + danger + " 操作，请勾选「允许执行」后重试");
            }
        }
        return R.ok(explain.explain(instanceId, sql));
    }

    @PostMapping("/optimize")
    public Map<String, Object> optimize(CurrentUser u, @RequestBody Map<String, Object> b) {
        u.require("ADMIN", "DBA", "OPS");
        String sql = Values.str(b.get("sqlText"), "");
        if (sql.isBlank()) {
            return R.badRequest("SQL不能为空");
        }
        Map<String, Object> a = auditSvc.audit(new SqlAuditService.Request(sql, Values.str(b.get("dbType")), Values.str(b.get("schema")),
                Values.toLong(b.get("instanceId")), false, false));
        return R.ok(R.map("suggestions", auditSvc.optimizeSuggestions(a), "score", a.get("score"), "risk", a.get("risk")));
    }

    /**
     * 立即采集慢 SQL：直接从源库统计视图取“单次平均耗时 ≥ 阈值”的 SQL，整批写入 SQL_SLOW_SUMMARY（按采集时间）。
     * 支持 Oracle / 磐维 / 达梦 / MySQL / GoldenDB / PostgreSQL / SQL Server；minAvgMs 可临时覆盖阈值。
     */
    @PostMapping("/capture/{instanceId}")
    public Map<String, Object> capture(CurrentUser u, @PathVariable long instanceId, @RequestParam(required = false) Double minAvgMs) {
        u.require("ADMIN", "DBA", "OPS");
        Map<String, Object> s = slowSql.capture(instanceId, "MANUAL", minAvgMs);
        if (s.get("error") != null) {
            return R.fail(500, "采集失败：" + s.get("error"));
        }
        long n = Values.toLong(s.get("count"), 0);
        String msg = n > 0 ? String.format("已采集 %d 条慢 SQL（%s，单次平均耗时 ≥ %s ms），采集时间 %s", n, s.get("source"), s.get("minAvgMs"), s.get("captureTime"))
                : String.format("采集完成：当前没有单次平均耗时 ≥ %s ms 的 SQL（%s）", s.get("minAvgMs"), s.get("source"));
        return R.ok(s, msg);
    }
}
