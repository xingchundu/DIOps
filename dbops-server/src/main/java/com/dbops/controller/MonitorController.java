package com.dbops.controller;

import com.dbops.common.BizException;
import com.dbops.common.Db;
import com.dbops.common.R;
import com.dbops.common.Values;
import com.dbops.monitor.CmdbInstance;
import com.dbops.monitor.CollectService;
import com.dbops.monitor.DbType;
import com.dbops.monitor.ExporterCollector;
import com.dbops.monitor.TargetConnector;
import com.dbops.monitor.TargetDb;
import com.dbops.security.CurrentUser;
import com.dbops.service.AuditService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;

/**
 * /api/monitor（同 Node routes/monitor.js）
 */
@RestController
@RequestMapping("/api/monitor")
public class MonitorController {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final Db db;
    private final TargetConnector connector;
    private final ExporterCollector exporter;
    private final CollectService collect;
    private final AuditService audit;
    private final com.dbops.monitor.MonitorBoardService board;
    private final com.dbops.monitor.DashboardService dashboard;
    private final com.dbops.monitor.ReportService reports;

    public MonitorController(Db db, TargetConnector connector, ExporterCollector exporter, CollectService collect, AuditService audit,
                             com.dbops.monitor.MonitorBoardService board, com.dbops.monitor.DashboardService dashboard,
                             com.dbops.monitor.ReportService reports) {
        this.reports = reports;
        this.board = board;
        this.dashboard = dashboard;
        this.db = db;
        this.connector = connector;
        this.exporter = exporter;
        this.collect = collect;
        this.audit = audit;
    }

    /** 被管库报错原样返回（ORA-01017 之类对排障很重要），与 Node 版一致 */
    private static Map<String, Object> wrap(Callable<Object> c) {
        try {
            return R.ok(c.call());
        } catch (BizException e) {
            return R.fail(e.getCode(), e.getMessage());
        } catch (Exception e) {
            return R.fail(500, String.valueOf(e.getMessage()));
        }
    }

    // 原 GET /collect-scheduler/status（“定时采集观测”页面）已删除：采集状态在监控中心实例列表中查看

    @GetMapping("/overview")
    public Map<String, Object> overview() {
        Map<String, Object> r = db.one("SELECT (SELECT COUNT(*) FROM CMDB_INSTANCE) AS TOTAL, "
                + "(SELECT COUNT(*) FROM ALERT_RECORD WHERE STATUS='OPEN') AS ALERTS, "
                + "(SELECT COUNT(*) FROM CMDB_INSTANCE WHERE STATUS='RUNNING') AS RUNNING, "
                + "(SELECT COUNT(*) FROM CMDB_INSTANCE WHERE HEALTH_SCORE>=90 AND STATUS='RUNNING') AS HEALTHY FROM DUAL");
        return R.ok(R.map("totalInstances", r.get("TOTAL"), "openAlerts", r.get("ALERTS"),
                "runningInstances", r.get("RUNNING"), "healthyInstances", r.get("HEALTHY")));
    }

    /** 监控中心总览：实例状态、健康等级、扣分项、关键指标、近 2 小时走势、未处理告警 */
    @GetMapping("/board")
    public Map<String, Object> board() {
        return R.ok(board.board());
    }

    /** 控制台汇总 */
    @GetMapping("/dashboard")
    public Map<String, Object> dashboard() {
        return R.ok(dashboard.summary());
    }

    /**
     * 运行报告：type = DAY（昨天）/ WEEK（上周）/ MONTH（上月）/ CUSTOM（from、to 为 yyyy-MM-dd，含首尾两天）；
     * 可按 env 或 instanceId 限定范围
     */
    @GetMapping("/report")
    public Map<String, Object> report(@org.springframework.web.bind.annotation.RequestParam(required = false) String type,
                                      @org.springframework.web.bind.annotation.RequestParam(required = false) String from,
                                      @org.springframework.web.bind.annotation.RequestParam(required = false) String to,
                                      @org.springframework.web.bind.annotation.RequestParam(required = false) String env,
                                      @org.springframework.web.bind.annotation.RequestParam(required = false) Long instanceId) {
        return wrap(() -> {
            java.time.LocalDateTime[] p = com.dbops.monitor.ReportService.period(type, java.time.LocalDate.now(java.time.ZoneId.of("Asia/Shanghai")), from, to);
            Map<String, Object> r = reports.build(new com.dbops.monitor.ReportService.Scope(p[0], p[1], env, instanceId));
            r.put("type", type == null ? "WEEK" : type.toUpperCase());
            return r;
        });
    }

    @GetMapping("/instances")
    public Map<String, Object> instances() {
        return R.ok(db.query("SELECT i.INSTANCE_ID,i.INSTANCE_NAME,i.DB_TYPE,i.HOST_IP,i.PORT,i.STATUS,i.HEALTH_SCORE,i.ENVIRONMENT,"
                + "i.BIZ_LINE,i.ROLE,i.LAST_CHECK,(SELECT COUNT(*) FROM ALERT_RECORD a WHERE a.INSTANCE_ID=i.INSTANCE_ID AND a.STATUS='OPEN') AS OPEN_ALERTS "
                + "FROM CMDB_INSTANCE i ORDER BY i.INSTANCE_ID"));
    }

    @GetMapping("/instances/{id}/basic")
    public Map<String, Object> basic(@PathVariable("id") long id) {
        Map<String, Object> r = db.one("SELECT i.*,h.HOSTNAME,h.OS_TYPE,h.OS_VERSION,h.CPU_CORES,h.MEMORY_GB,h.DATACENTER,"
                + "(SELECT COUNT(*) FROM ALERT_RECORD a WHERE a.INSTANCE_ID=i.INSTANCE_ID AND a.STATUS='OPEN') OPEN_ALERTS "
                + "FROM CMDB_INSTANCE i LEFT JOIN CMDB_HOST h ON i.HOST_ID=h.HOST_ID WHERE i.INSTANCE_ID=?", id);
        if (r == null) {
            return R.notFound("实例不存在");
        }
        Map<String, Object> d = new LinkedHashMap<>(r);
        d.remove("DB_PASSWORD");
        return R.ok(d);
    }

    @PostMapping("/instances/{id}/collect")
    public Map<String, Object> collectNow(CurrentUser u, @PathVariable("id") long id) {
        u.require("ADMIN", "DBA", "OPS");
        Map<String, Object> data = collect.collectInstance(id);
        boolean ok = Boolean.TRUE.equals(data.get("ok"));
        return R.ok(data, ok ? "采集已入库" : Values.str(data.get("err"), "采集失败"));
    }

    @PutMapping("/instances/{id}/collect-schedule")
    public Map<String, Object> collectSchedule(CurrentUser u, @PathVariable("id") long id, @RequestBody(required = false) Map<String, Object> body) {
        u.require("ADMIN", "DBA");
        Object raw = Values.get(body, "intervalSec") != null ? Values.get(body, "intervalSec") : Values.get(body, "collectIntervalSec");
        Long sec = Values.toStrictLong(raw);
        if (sec == null || sec < 0) {
            return R.badRequest("intervalSec 须为 >= 0 的整数（秒）");
        }
        if (sec > 0 && sec < 60) {
            return R.badRequest("自动采集间隔不能小于 60 秒");
        }
        long v = Math.min(sec, 86400);
        try {
            int n = db.update("UPDATE CMDB_INSTANCE SET COLLECT_INTERVAL_SEC = ?, UPDATED_AT = SYSTIMESTAMP WHERE INSTANCE_ID = ?", v, id);
            if (n == 0) {
                return R.notFound("实例不存在");
            }
        } catch (Exception e) {
            if (Db.isMissingColumn(e)) {
                return R.fail(500, "缺少 COLLECT_INTERVAL_SEC 字段，请先执行 migration_monitor_instance_collect.sql");
            }
            throw e;
        }
        return R.ok(R.map("intervalSec", v), v > 0 ? "已设置本实例每 " + v + " 秒自动采集" : "已关闭本实例单独自动采集");
    }

    @GetMapping("/instances/{id}/trend")
    public Map<String, Object> trend(@PathVariable("id") long id, @RequestParam(required = false, defaultValue = "1h") String range) {
        return R.ok(R.map("range", range, "series", collect.trendSeries(id, range)));
    }

    @GetMapping("/instances/{id}/performance")
    public Map<String, Object> performance(@PathVariable("id") long id) {
        return wrap(() -> exporter.performance(id));
    }

    @GetMapping("/instances/{id}/tablespaces")
    public Map<String, Object> tablespaces(@PathVariable("id") long id) {
        return wrap(() -> exporter.tablespaces(id));
    }

    /** 运行自检：逐条验证该实例的表空间查询链路（19c / legacy / 仅名称）及原始 ORA 错误 */
    @GetMapping("/instances/{id}/tablespace-diagnostics")
    public Map<String, Object> tablespaceDiagnostics(@PathVariable("id") long id) {
        return wrap(() -> exporter.oracleTablespaceDiagnostics(id));
    }

    @GetMapping("/instances/{id}/sessions")
    public Map<String, Object> sessions(@PathVariable("id") long id,
                                        @RequestParam(required = false) String status,
                                        @RequestParam(required = false) String username,
                                        @RequestParam(required = false) String onlyActive) {
        boolean oa = "1".equals(onlyActive) || "true".equalsIgnoreCase(onlyActive);
        return wrap(() -> exporter.sessions(id, oa, status, username));
    }

    @PostMapping("/instances/{id}/sessions/kill")
    public Map<String, Object> killSession(CurrentUser u, @PathVariable("id") long id, @RequestBody(required = false) Map<String, Object> body) {
        if (!u.hasRole("ADMIN", "DBA")) {
            return R.forbidden();
        }
        Object sidRaw = Values.get(body, "sid");
        Object serialRaw = Values.get(body, "serial");
        if (Values.isBlank(sidRaw) || Values.isBlank(serialRaw)) {
            return R.badRequest("sid 和 serial 不能为空");
        }
        Long sid = Values.toStrictLong(sidRaw);
        Long serial = Values.toStrictLong(serialRaw);
        if (sid == null || sid <= 0 || serial == null || serial <= 0) {
            return R.badRequest("sid 和 serial 必须为正整数");
        }
        return wrapMsg(() -> {
            CmdbInstance inst = connector.fetch(id);
            if (!DbType.ORACLE.equals(inst.dbType())) {
                throw BizException.badRequest("该操作仅支持 Oracle 实例");
            }
            try (TargetDb t = connector.open(inst)) {
                // sid/serial 已校验为正整数，拼接安全
                t.execute("ALTER SYSTEM KILL SESSION '" + sid + "," + serial + "' IMMEDIATE");
            }
            audit.log(u, "KILL_SESSION", "CMDB_INSTANCE", String.valueOf(id), "SUCCESS", "SID=" + sid + ",SERIAL#=" + serial);
            return "会话 " + sid + "," + serial + " 已终止";
        });
    }

    private static Map<String, Object> wrapMsg(Callable<String> c) {
        try {
            return R.msg(c.call());
        } catch (BizException e) {
            return R.fail(e.getCode(), e.getMessage());
        } catch (Exception e) {
            return R.fail(500, String.valueOf(e.getMessage()));
        }
    }

    // 原 GET /instances/{id}/topsql（实例详情“④ SQL分析”实时 Top SQL）已删除，由 SQL 洞察（分钟统计 + 慢 SQL 快照）取代

    @GetMapping("/instances/{id}/waits")
    public Map<String, Object> waits(@PathVariable("id") long id) {
        return wrap(() -> exporter.waits(id));
    }

    @GetMapping("/instances/{id}/locks")
    public Map<String, Object> locks(@PathVariable("id") long id) {
        try {
            CmdbInstance inst = connector.fetch(id);
            if (!DbType.ORACLE.equals(inst.dbType())) {
                return R.ok(List.of(), "仅 Oracle 支持锁分析");
            }
            try (TargetDb t = connector.open(inst)) {
                return R.ok(t.query("SELECT HOLDER.SID HOLDER_SID, HS.SERIAL# HOLDER_SERIAL, HS.USERNAME HOLDER_USER, HS.PROGRAM HOLDER_PROG, "
                        + "WAITER.SID WAITER_SID, WS.SERIAL# WAITER_SERIAL, WS.USERNAME WAITER_USER, WS.PROGRAM WAITER_PROG, "
                        + "ROUND(WS.LAST_CALL_ET/60,1) WAIT_MIN, WS.EVENT WAIT_EVENT FROM V$LOCK HOLDER "
                        + "JOIN V$LOCK WAITER ON HOLDER.ID1=WAITER.ID1 AND HOLDER.ID2=WAITER.ID2 AND HOLDER.TYPE=WAITER.TYPE "
                        + "AND HOLDER.BLOCK=1 AND WAITER.REQUEST>0 JOIN V$SESSION HS ON HOLDER.SID=HS.SID "
                        + "JOIN V$SESSION WS ON WAITER.SID=WS.SID ORDER BY WAIT_MIN DESC"));
            }
        } catch (BizException e) {
            return R.fail(e.getCode(), e.getMessage());
        } catch (Exception e) {
            return R.fail(500, String.valueOf(e.getMessage()));
        }
    }

    @GetMapping("/instances/{id}/awr-snapshots")
    public Map<String, Object> awrSnapshots(@PathVariable("id") long id) {
        return wrap(() -> {
            CmdbInstance inst = connector.fetch(id);
            if (!DbType.ORACLE.equals(inst.dbType())) {
                return List.of();
            }
            try (TargetDb t = connector.open(inst)) {
                return t.query("SELECT SNAP_ID, DBID, INSTANCE_NUMBER, BEGIN_TIME, END_TIME FROM ("
                        + "SELECT SNAP_ID, DBID, INSTANCE_NUMBER, TO_CHAR(BEGIN_INTERVAL_TIME,'YYYY-MM-DD HH24:MI') BEGIN_TIME, "
                        + "TO_CHAR(END_INTERVAL_TIME,'YYYY-MM-DD HH24:MI') END_TIME FROM DBA_HIST_SNAPSHOT "
                        + "WHERE DBID = (SELECT DBID FROM V$DATABASE) AND INSTANCE_NUMBER = (SELECT INSTANCE_NUMBER FROM V$INSTANCE) "
                        + "ORDER BY SNAP_ID DESC) WHERE ROWNUM <= 48");
            }
        });
    }

    @PostMapping("/instances/{id}/awr-report")
    public Map<String, Object> awrReport(CurrentUser u, @PathVariable("id") long id, @RequestBody(required = false) Map<String, Object> body) {
        u.require("ADMIN", "DBA");
        Long begin = Values.toStrictLong(Values.get(body, "beginSnap"));
        Long end = Values.toStrictLong(Values.get(body, "endSnap"));
        String format = "text".equalsIgnoreCase(Values.str(Values.get(body, "format"), "html")) ? "text" : "html";
        if (begin == null || end == null || begin <= 0 || end <= 0 || end <= begin) {
            return R.badRequest("beginSnap/endSnap 必须为正整数且 endSnap > beginSnap");
        }
        try {
            CmdbInstance inst = connector.fetch(id);
            if (!DbType.ORACLE.equals(inst.dbType())) {
                return R.badRequest("该操作仅支持 Oracle 实例");
            }
            String report;
            try (TargetDb t = connector.open(inst)) {
                Long dbid = Values.toLong(Values.get(body, "dbid"));
                Long instNum = Values.toLong(Values.get(body, "instanceNumber"));
                if (dbid == null || instNum == null) {
                    Map<String, Object> meta = t.one("SELECT (SELECT DBID FROM V$DATABASE) AS DBID, (SELECT INSTANCE_NUMBER FROM V$INSTANCE) AS INSTANCE_NUMBER FROM DUAL");
                    dbid = Values.toLong(meta.get("DBID"));
                    instNum = Values.toLong(meta.get("INSTANCE_NUMBER"));
                }
                String fn = "html".equals(format) ? "AWR_REPORT_HTML" : "AWR_REPORT_TEXT";
                List<Map<String, Object>> rows = t.queryMax(0, "SELECT OUTPUT AS LINE FROM TABLE(DBMS_WORKLOAD_REPOSITORY." + fn + "(?, ?, ?, ?))",
                        dbid, instNum, begin, end);
                StringBuilder sb = new StringBuilder();
                for (Map<String, Object> r : rows) {
                    Object line = r.get("LINE");
                    if (line == null) {
                        if ("text".equals(format)) {
                            sb.append('\n');
                        }
                        continue;
                    }
                    sb.append(line);
                    if ("text".equals(format)) {
                        sb.append('\n');
                    }
                }
                report = sb.toString();
            }
            if (report.isBlank()) {
                return R.fail(500, "AWR 报告为空：请确认快照区间有效，且监控账号具备 DBA_HIST 访问及 DBMS_WORKLOAD_REPOSITORY 执行权限（Diagnostics 许可）");
            }
            return R.ok(R.map("beginSnap", begin, "endSnap", end, "format", format, "report", report));
        } catch (BizException e) {
            return R.fail(e.getCode(), e.getMessage());
        } catch (Exception e) {
            String msg = String.valueOf(e.getMessage());
            if (msg.contains("ORA-01031") || msg.toLowerCase().contains("insufficient privileges")) {
                msg += " — 请授予 SELECT_CATALOG_ROLE 或对 DBA_HIST_* 的 SELECT，以及 DBMS_WORKLOAD_REPOSITORY 的 EXECUTE";
            } else if (msg.contains("ORA-06512") || msg.contains("AWR_REPORT")) {
                msg += " — 请确认 Diagnostics Pack 许可及快照 ID 属于当前连接实例";
            }
            return R.fail(500, msg);
        }
    }

    @GetMapping("/instances/{id}/alerts")
    public Map<String, Object> instanceAlerts(@PathVariable("id") long id) {
        return R.ok(db.query("SELECT * FROM ALERT_RECORD WHERE INSTANCE_ID=? ORDER BY TRIGGER_TIME DESC FETCH FIRST 50 ROWS ONLY", id));
    }

    @GetMapping("/instances/{id}/audit")
    public Map<String, Object> instanceAudit(@PathVariable("id") long id) {
        // [fix] Node 版 RESOURCE_ID=:1 OR DETAIL LIKE '%Instance:1%'：会混入其他资源（用户/规则）同 ID 的审计，且匹配 Instance:10/11…
        return R.ok(db.query("SELECT * FROM SYS_AUDIT_LOG WHERE (\"RESOURCE\" = 'CMDB_INSTANCE' AND RESOURCE_ID = ?) "
                        + "OR REGEXP_LIKE(DETAIL, ?) ORDER BY CREATED_AT DESC FETCH FIRST 100 ROWS ONLY",
                String.valueOf(id), "Instance:" + id + "([^0-9]|$)"));
    }

    @GetMapping("/instances/{id}/sysinfo")
    public Map<String, Object> sysinfo(@PathVariable("id") long id) {
        return wrap(() -> exporter.sysinfo(id));
    }

    /** 健康评分明细：等级、扣分项、各分类结论、已检查项数（旧版样本只有“维度”） */
    @GetMapping("/instances/{id}/health-detail")
    public Map<String, Object> healthDetail(@PathVariable("id") long id) {
        Map<String, Object> r = db.one("SELECT HEALTH_SCORE, HEALTH_DETAIL, COLLECTED_AT, REACHABLE, ERR_MSG FROM MONITOR_METRIC_SAMPLE "
                + "WHERE INSTANCE_ID = ? ORDER BY COLLECTED_AT DESC FETCH FIRST 1 ROWS ONLY", id);
        if (r == null) {
            return R.ok(R.map("score", null, "dimensions", null, "collectedAt", null));
        }
        Object parsed = parseJson(r.get("HEALTH_DETAIL"));
        boolean reachable = Values.toLong(r.get("REACHABLE"), 1) == 1;
        Map<String, Object> out = new java.util.LinkedHashMap<>();
        out.put("score", reachable ? r.get("HEALTH_SCORE") : null);
        out.put("reachable", r.get("REACHABLE"));
        out.put("collectedAt", r.get("COLLECTED_AT"));
        if (!reachable) {
            out.put("error", com.dbops.monitor.MonitorBoardService.friendlyError(Values.str(r.get("ERR_MSG"), "")));
            out.put("errorDetail", r.get("ERR_MSG"));
        }
        if (parsed instanceof Map<?, ?> d && d.get("version") != null) {
            out.put("grade", reachable ? d.get("grade") : "OFFLINE");
            out.put("issues", d.get("issues"));
            out.put("checked", d.get("checked"));
            out.put("keyMetrics", d.get("keyMetrics"));
            out.put("dimensions", d.get("categories"));
        } else {
            out.put("grade", reachable ? com.dbops.monitor.HealthScorer.grade(Values.toLong(r.get("HEALTH_SCORE")) == null ? null
                    : Values.toLong(r.get("HEALTH_SCORE")).intValue()) : "OFFLINE");
            out.put("dimensions", parsed);
            out.put("legacy", true);
        }
        return R.ok(out);
    }

    @GetMapping("/instances/{id}/engine-phase2")
    public Map<String, Object> enginePhase2(@PathVariable("id") long id) {
        Map<String, Object> r = latestJson(id);
        if (r == null) {
            return R.ok(R.map("phase2", null, "collectedAt", null));
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> p = (Map<String, Object>) r.get("json");
        return R.ok(R.map("collectedAt", r.get("at"),
                "engineMetrics", p.getOrDefault("engineMetrics", List.of()),
                "enginePhase2Summary", p.get("enginePhase2Summary"),
                "hostMetrics", p.getOrDefault("hostMetrics", List.of()),
                "hostSummary", p.get("hostSummary")));
    }

    @GetMapping("/instances/{id}/host-checks")
    public Map<String, Object> hostChecks(@PathVariable("id") long id) {
        Map<String, Object> r = latestJson(id);
        if (r == null) {
            return R.ok(R.map("hostMetrics", List.of(), "hostSummary", null, "collectedAt", null));
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> p = (Map<String, Object>) r.get("json");
        return R.ok(R.map("collectedAt", r.get("at"), "hostMetrics", p.getOrDefault("hostMetrics", List.of()),
                "hostSummary", p.get("hostSummary")));
    }

    private Map<String, Object> latestJson(long id) {
        Map<String, Object> r = db.one("SELECT METRICS_JSON, COLLECTED_AT FROM MONITOR_METRIC_SAMPLE WHERE INSTANCE_ID = ? "
                + "ORDER BY COLLECTED_AT DESC FETCH FIRST 1 ROWS ONLY", id);
        if (r == null || r.get("METRICS_JSON") == null) {
            return null;
        }
        Object parsed = parseJson(r.get("METRICS_JSON"));
        return R.map("at", r.get("COLLECTED_AT"), "json", parsed instanceof Map<?, ?> ? parsed : new LinkedHashMap<>());
    }

    private static Object parseJson(Object s) {
        if (s == null) {
            return null;
        }
        try {
            return MAPPER.readValue(String.valueOf(s), Object.class);
        } catch (Exception e) {
            return null;
        }
    }

    @GetMapping("/catalog")
    public Map<String, Object> catalog(@RequestParam(required = false) String dbType,
                                       @RequestParam(required = false) String mode,
                                       @RequestParam(required = false, defaultValue = "1") String page,
                                       @RequestParam(required = false, defaultValue = "50") String size) {
        List<String> where = new ArrayList<>(List.of("ENABLED = 1"));
        List<Object> args = new ArrayList<>();
        if (!Values.isBlank(dbType)) {
            where.add("DB_TYPE = ?");
            args.add(dbType.trim().toUpperCase());
        }
        if (!Values.isBlank(mode)) {
            where.add("COLLECT_MODE = ?");
            args.add(mode.trim().toUpperCase());
        }
        try {
            return R.ok(db.queryPage("SELECT CATALOG_ID, SOURCE_FILE, ITEM_NO, DB_TYPE, CATEGORY, SUBCATEGORY, ITEM_NAME, COLLECT_MODE, "
                    + "METRIC_KEY, THRESHOLD_TEXT, SEVERITY_LABEL FROM DB_MONITOR_CATALOG WHERE " + String.join(" AND ", where)
                    + " ORDER BY DB_TYPE, ITEM_NO", args, page, size));
        } catch (Exception e) {
            if (Db.isMissingTable(e)) {
                return R.ok(R.map("list", List.of(), "total", 0, "msg", "请先执行 migration_monitor_catalog.sql"));
            }
            throw e;
        }
    }
}
