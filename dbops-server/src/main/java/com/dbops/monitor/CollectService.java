package com.dbops.monitor;

import com.dbops.alert.AlertEvaluator;
import com.dbops.common.Db;
import com.dbops.common.R;
import com.dbops.common.Values;
import com.dbops.config.DbopsProperties;
import com.dbops.service.SystemConfigService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 采集单实例并入库（对应 Node services/monitorCollectPersist.js）。
 * <p>
 * 相对 Node 版的修正：
 * <ul>
 *   <li>[fix] 全量定时任务与实例级定时任务、以及“立即采集”按钮可能同时采同一实例（重复样本、重复告警）：加实例级互斥</li>
 *   <li>[fix] 不可达实例健康分 40 → 0；不可达时也做告警评估（db_reachable=0）</li>
 *   <li>[fix] 告警评估覆盖全部库类型；主机 SSH 指标覆盖全部库类型</li>
 *   <li>[fix] 保留期清理：先删 ALERT_SUPPRESSION / ALERT_SILENCE_LOG 子表，否则外键报错（被吞）导致告警表永不清理；
 *       清理从“每轮”降到“每 10 分钟”</li>
 *   <li>[改进] 一次采集只建 1 条被管库连接（Node 版 3~4 条）</li>
 * </ul>
 */
@Service
public class CollectService {

    private static final Logger log = LoggerFactory.getLogger(CollectService.class);
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Map<String, Integer> RANGE_HOURS = Map.of("1h", 1, "6h", 6, "1d", 24, "7d", 168);

    private final Db db;
    private final TargetConnector connector;
    private final ExporterCollector exporter;
    private final EngineMetricsCollector engine;
    private final HostCollector host;
    private final AlertEvaluator alerts;
    private final SystemConfigService cfg;
    private final DbopsProperties.Monitor monitorCfg;

    private final Set<Long> inFlight = ConcurrentHashMap.newKeySet();
    private final Set<Long> seeded = ConcurrentHashMap.newKeySet();
    private final ExecutorService pool;
    private volatile long lastPrune = 0;

    public CollectService(Db db, TargetConnector connector, ExporterCollector exporter, EngineMetricsCollector engine,
                          HostCollector host, AlertEvaluator alerts, SystemConfigService cfg, DbopsProperties props) {
        this.db = db;
        this.connector = connector;
        this.exporter = exporter;
        this.engine = engine;
        this.host = host;
        this.alerts = alerts;
        this.cfg = cfg;
        this.monitorCfg = props.getMonitor();
        AtomicInteger n = new AtomicInteger();
        this.pool = Executors.newFixedThreadPool(Math.max(1, monitorCfg.getCollectConcurrency()), r -> {
            Thread t = new Thread(r, "collect-" + n.incrementAndGet());
            t.setDaemon(true);
            return t;
        });
    }

    @PreDestroy
    public void shutdown() {
        pool.shutdownNow();
    }

    /** 全局采集周期：环境变量 MONITOR_COLLECT_INTERVAL_MS 优先，其次 SYS_CONFIG monitor.collect.interval_ms，最小 60s */
    public long intervalMs() {
        Long env = Values.toLong(monitorCfg.getCollectIntervalMs());
        long v = env != null ? env : cfg.getLong("monitor.collect.interval_ms", 90_000);
        return Math.max(60_000, v);
    }

    public Map<String, Object> collectInstance(long instanceId) {
        if (!inFlight.add(instanceId)) {
            return R.map("ok", false, "err", "该实例正在采集中，请稍后", "instanceId", instanceId);
        }
        try {
            return doCollect(instanceId);
        } finally {
            inFlight.remove(instanceId);
        }
    }

    private Map<String, Object> doCollect(long instanceId) {
        CmdbInstance inst;
        try {
            inst = connector.fetch(instanceId);
        } catch (Exception e) {
            return R.map("ok", false, "err", e.getMessage());
        }
        String dbType = inst.dbType();
        if (!DbType.isMonitored(dbType)) {
            return R.map("ok", false, "err", "监控采集不支持类型: " + dbType);
        }
        seedCounters(instanceId);
        Map<String, Object> bundle;
        List<Map<String, Object>> engineMetrics = new ArrayList<>();
        Map<String, Object> phase2 = null;
        try (TargetDb t = connector.open(inst)) {
            bundle = exporter.performance(t, inst);
            if (DbType.ORACLE.equals(dbType) || DbType.PANWEI.equals(dbType)) {
                try {
                    @SuppressWarnings("unchecked")
                    List<Map<String, Object>> m = (List<Map<String, Object>>) bundle.get("metrics");
                    EngineMetricsCollector.Result r = engine.collect(t, inst, m);
                    engineMetrics = r.engineMetrics();
                    phase2 = r.phase2Summary();
                } catch (Exception emErr) {
                    log.warn("[monitor-collect] engineMetrics {}: {}", instanceId, emErr.getMessage());
                }
            }
        } catch (Exception e) {
            return persistFailure(inst, e);
        }

        HostCollector.Result hr;
        try {
            hr = host.collect(instanceId, dbType);
        } catch (Exception hcErr) {
            log.warn("[monitor-collect] hostCollect {}: {}", instanceId, hcErr.getMessage());
            hr = new HostCollector.Result(List.of(Metrics.internal("_host_error", Values.truncate(hcErr.getMessage(), 120), null)), null);
        }

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> metrics = (List<Map<String, Object>>) bundle.get("metrics");
        Double sshCpu = Metrics.keyValue(hr.hostMetrics(), "host_cpu_used_pct");
        Double panweiCpu = Metrics.keyValue(engineMetrics, "panwei_host_cpu_pct");
        // 磐维关联主机经常是监控机，SSH 的 CPU 不是数据库所在主机。趋势只记库内采样。
        Double trendCpu = DbType.PANWEI.equals(dbType) ? panweiCpu : (panweiCpu != null ? panweiCpu : sshCpu);
        Double[] trend = HealthScorer.trend(dbType, metrics, trendCpu);
        HealthScorer.Score score = HealthScorer.compute(dbType, new HealthScorer.Snapshot(metrics, engineMetrics, hr.hostMetrics()));

        Map<String, Object> json = new LinkedHashMap<>();
        json.put("exporter", bundle.get("exporter"));
        json.put("metrics", metrics);
        json.put("sessions", bundle.get("sessions"));
        json.put("engineMetrics", engineMetrics);
        json.put("enginePhase2Summary", phase2);
        json.put("hostMetrics", hr.hostMetrics());
        json.put("hostSummary", hr.hostSummary());

        insertSample(instanceId, dbType, 1, score.score(), toJson(score.dimensions()), trend[0], trend[1], toJson(json), null);
        db.update("UPDATE CMDB_INSTANCE SET LAST_CHECK = SYSTIMESTAMP, STATUS = 'RUNNING', HEALTH_SCORE = ?, UPDATED_AT = SYSTIMESTAMP "
                + "WHERE INSTANCE_ID = ?", score.score(), instanceId);

        try {
            List<Map<String, Object>> all = new ArrayList<>(engineMetrics);
            all.addAll(hr.hostMetrics());
            alerts.evaluate(instanceId, inst.instanceName(), dbType,
                    AlertEvaluator.metricMap(all, metrics, true, score.score(), dbType), inst.hostIp());
        } catch (Exception ae) {
            log.warn("[monitor-collect] alertEval {}: {}", instanceId, ae.getMessage());
        }
        return R.map("ok", true, "healthScore", score.score(), "dimensions", score.dimensions(), "instanceId", instanceId);
    }

    private Map<String, Object> persistFailure(CmdbInstance inst, Exception e) {
        String errMsg = Values.truncate(String.valueOf(e.getMessage()), 500);
        HealthScorer.Score score = HealthScorer.offline(errMsg);
        try {
            insertSample(inst.instanceId(), inst.dbType(), 0, score.score(), toJson(score.dimensions()), null, null, null, errMsg);
            db.update("UPDATE CMDB_INSTANCE SET LAST_CHECK = SYSTIMESTAMP, STATUS = 'ERROR', HEALTH_SCORE = ?, UPDATED_AT = SYSTIMESTAMP "
                    + "WHERE INSTANCE_ID = ?", score.score(), inst.instanceId());
        } catch (Exception dbErr) {
            log.error("[monitor-collect] persist failure sample {}: {}", inst.instanceId(), dbErr.getMessage());
        }
        try {
            alerts.evaluate(inst.instanceId(), inst.instanceName(), inst.dbType(),
                    AlertEvaluator.metricMap(null, null, false, score.score(), inst.dbType()), inst.hostIp());
        } catch (Exception ae) {
            log.warn("[monitor-collect] alertEval {}: {}", inst.instanceId(), ae.getMessage());
        }
        return R.map("ok", false, "err", errMsg, "dimensions", score.dimensions(), "instanceId", inst.instanceId());
    }

    private void insertSample(long instanceId, String dbType, int reachable, int health, String healthDetail,
                              Double cpu, Double conn, String metricsJson, String err) {
        try {
            db.update("INSERT INTO MONITOR_METRIC_SAMPLE (INSTANCE_ID, DB_TYPE, REACHABLE, HEALTH_SCORE, HEALTH_DETAIL, METRIC_CPU, "
                            + "METRIC_CONN, METRICS_JSON, ERR_MSG) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    instanceId, dbType, reachable, health, healthDetail, cpu, conn, metricsJson, err);
        } catch (Exception e) {
            if (Db.isMissingTable(e)) {
                log.warn("[monitor-collect] 表 MONITOR_METRIC_SAMPLE 不存在，请执行 sql/init.sql 中 DDL");
                return;
            }
            if (Db.isMissingColumn(e)) {
                // 旧库没有 HEALTH_DETAIL 列
                db.update("INSERT INTO MONITOR_METRIC_SAMPLE (INSTANCE_ID, DB_TYPE, REACHABLE, HEALTH_SCORE, METRIC_CPU, METRIC_CONN, "
                        + "METRICS_JSON, ERR_MSG) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", instanceId, dbType, reachable, health, cpu, conn, metricsJson, err);
                return;
            }
            throw e;
        }
    }

    /** 服务重启后用最近一条样本给累计计数器做基准，避免第一轮慢查询增量/速率缺失 */
    private void seedCounters(long instanceId) {
        if (!seeded.add(instanceId)) {
            return;
        }
        try {
            Map<String, Object> r = db.one("SELECT METRICS_JSON, COLLECTED_AT FROM (SELECT METRICS_JSON, COLLECTED_AT FROM MONITOR_METRIC_SAMPLE "
                    + "WHERE INSTANCE_ID = ? AND REACHABLE = 1 ORDER BY COLLECTED_AT DESC) WHERE ROWNUM = 1", instanceId);
            if (r == null || r.get("METRICS_JSON") == null || !(r.get("COLLECTED_AT") instanceof Timestamp ts)) {
                return;
            }
            JsonNode metrics = MAPPER.readTree(String.valueOf(r.get("METRICS_JSON"))).path("metrics");
            for (JsonNode m : metrics) {
                String name = m.path("METRIC_NAME").asText("");
                JsonNode v = m.get("VALUE");
                if (v == null || !v.isNumber()) {
                    continue;
                }
                switch (name) {
                    case "mysql_global_status_slow_queries" -> exporter.counters().seedIfAbsent(instanceId, "mysql_slow_queries", v.asDouble(), ts.getTime());
                    case "mysql_global_status_questions_total" -> exporter.counters().seedIfAbsent(instanceId, "mysql_questions", v.asDouble(), ts.getTime());
                    case "mssql_batch_requests_total" -> exporter.counters().seedIfAbsent(instanceId, "mssql_batch_requests", v.asDouble(), ts.getTime());
                    default -> {
                    }
                }
            }
        } catch (Exception e) {
            log.debug("[monitor-collect] seed counters {}: {}", instanceId, e.getMessage());
        }
    }

    /**
     * 全量采集（定时任务调用）。设置了实例级 COLLECT_INTERVAL_SEC 的实例由实例级调度负责，这里跳过，避免重复采集。
     */
    public void collectAll(Runnable afterRound) {
        List<Map<String, Object>> rows;
        try {
            rows = db.query("SELECT INSTANCE_ID FROM CMDB_INSTANCE WHERE UPPER(DB_TYPE) IN ('ORACLE','MYSQL','POSTGRESQL','DAMENG','GOLDENDB','PANWEI','SQLSERVER','MSSQL') "
                    + "AND NVL(STATUS,'UNKNOWN') <> 'STOPPED' AND NVL(COLLECT_INTERVAL_SEC, 0) <= 0");
        } catch (Exception e) {
            if (!Db.isMissingColumn(e)) {
                throw e;
            }
            rows = db.query("SELECT INSTANCE_ID FROM CMDB_INSTANCE WHERE UPPER(DB_TYPE) IN ('ORACLE','MYSQL','POSTGRESQL','DAMENG','GOLDENDB','PANWEI','SQLSERVER','MSSQL') "
                    + "AND NVL(STATUS,'UNKNOWN') <> 'STOPPED'");
        }
        List<Future<?>> futures = new ArrayList<>();
        for (Map<String, Object> r : rows) {
            long id = Values.toLong(r.get("INSTANCE_ID"), 0);
            futures.add(pool.submit(() -> {
                try {
                    collectInstance(id);
                } catch (Exception e) {
                    log.error("[monitor-collect] instance {}: {}", id, e.getMessage());
                }
            }));
        }
        for (Future<?> f : futures) {
            try {
                f.get(5, TimeUnit.MINUTES);
            } catch (Exception e) {
                f.cancel(true);
            }
        }
        if (System.currentTimeMillis() - lastPrune > 10 * 60_000L) {
            lastPrune = System.currentTimeMillis();
            pruneOldSamples();
        }
        if (afterRound != null) {
            afterRound.run();
        }
    }

    public void submit(long instanceId) {
        pool.submit(() -> {
            try {
                collectInstance(instanceId);
            } catch (Exception e) {
                log.warn("[monitor-instance-scheduler] {}: {}", instanceId, e.getMessage());
            }
        });
    }

    public boolean isCollecting(long instanceId) {
        return inFlight.contains(instanceId);
    }

    void pruneOldSamples() {
        try {
            long metricDays = Math.max(1, cfg.getLong("retention.metric_sample_days", 8));
            db.update("DELETE FROM MONITOR_METRIC_SAMPLE WHERE COLLECTED_AT < SYSTIMESTAMP - NUMTODSINTERVAL(?, 'DAY')", metricDays);
        } catch (Exception e) {
            if (!Db.isMissingTable(e)) {
                log.warn("[monitor-collect] prune samples: {}", e.getMessage());
            }
        }
        long alertDays = cfg.getLong("retention.alert_record_days", 90);
        if (alertDays > 0) {
            String old = "SELECT ALERT_ID FROM ALERT_RECORD WHERE STATUS IN ('RESOLVED','CLOSED') AND TRIGGER_TIME < SYSTIMESTAMP - NUMTODSINTERVAL(?, 'DAY')";
            db.updateQuietly("DELETE FROM ALERT_SUPPRESSION WHERE PARENT_ALERT_ID IN (" + old + ") OR CHILD_ALERT_ID IN (" + old + ")", alertDays, alertDays);
            db.updateQuietly("DELETE FROM ALERT_SILENCE_LOG WHERE ALERT_ID IN (" + old + ")", alertDays);
            try {
                db.update("DELETE FROM ALERT_RECORD WHERE STATUS IN ('RESOLVED','CLOSED') AND TRIGGER_TIME < SYSTIMESTAMP - NUMTODSINTERVAL(?, 'DAY')", alertDays);
            } catch (Exception e) {
                log.warn("[monitor-collect] prune alerts: {}", e.getMessage());
            }
        }
        long sqlDays = cfg.getLong("retention.sql_history_days", 30);
        db.updateQuietly("DELETE FROM SQL_WORKBENCH_HISTORY WHERE CREATED_AT < SYSTIMESTAMP - NUMTODSINTERVAL(?, 'DAY')", sqlDays);
    }

    public List<Map<String, Object>> trendSeries(long instanceId, String rangeKey) {
        int hours = RANGE_HOURS.getOrDefault(rangeKey == null ? "1h" : rangeKey, 1);
        try {
            List<Map<String, Object>> out = new ArrayList<>();
            for (Map<String, Object> r : db.query("SELECT COLLECTED_AT, METRIC_CPU, METRIC_CONN, REACHABLE, HEALTH_SCORE FROM MONITOR_METRIC_SAMPLE "
                    + "WHERE INSTANCE_ID = ? AND COLLECTED_AT >= SYSTIMESTAMP - NUMTODSINTERVAL(?, 'HOUR') ORDER BY COLLECTED_AT ASC", instanceId, hours)) {
                out.add(R.map("t", r.get("COLLECTED_AT"),
                        "cpu", Values.toDouble(r.get("METRIC_CPU")),
                        "conn", Values.toDouble(r.get("METRIC_CONN")),
                        "reachable", r.get("REACHABLE"),
                        "healthScore", r.get("HEALTH_SCORE")));
            }
            return out;
        } catch (Exception e) {
            if (Db.isMissingTable(e)) {
                return new ArrayList<>();
            }
            throw e;
        }
    }

    private static String toJson(Object o) {
        try {
            return MAPPER.writeValueAsString(o);
        } catch (Exception e) {
            return null;
        }
    }
}
