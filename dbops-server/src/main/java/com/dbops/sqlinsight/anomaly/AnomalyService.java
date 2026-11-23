package com.dbops.sqlinsight.anomaly;

import com.dbops.common.Db;
import com.dbops.common.Values;
import com.dbops.service.SystemConfigService;
import com.dbops.sqlinsight.baseline.Baseline;
import com.dbops.sqlinsight.baseline.BaselineService;
import com.dbops.sqlinsight.collect.Counter;
import com.dbops.sqlinsight.collect.DeltaEngine;
import com.dbops.sqlinsight.collect.Metric;
import com.dbops.sqlinsight.collect.WindowRow;
import com.dbops.sqlinsight.diagnosis.DiagnosisService;
import com.dbops.sqlinsight.store.AlertBridge;
import com.dbops.sqlinsight.store.InstanceDirectory;
import com.dbops.sqlinsight.store.StatsRepo;
import org.springframework.stereotype.Service;

import java.sql.Timestamp;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 异常波动事件管理（设计方案 5.3 ~ 5.6）：单窗口判定 → 持续性 → 事件开/合并/升级/恢复 → 告警 → 触发诊断。
 * 持续性状态即 DI_SQL_STATS_MIN.ANOMALY_FLAGS，节点重启后从表里读回，不依赖 Redis。
 */
@Service
public class AnomalyService {

    public static final String INSTANCE_SCOPE_KEY = "*";

    private final Db db;
    private final BaselineService baselines;
    private final StatsRepo stats;
    private final AlertBridge alerts;
    private final SystemConfigService cfg;
    private final DiagnosisService diagnosis;

    public AnomalyService(Db db, BaselineService baselines, StatsRepo stats, AlertBridge alerts, SystemConfigService cfg,
                          DiagnosisService diagnosis) {
        this.db = db;
        this.baselines = baselines;
        this.stats = stats;
        this.alerts = alerts;
        this.cfg = cfg;
        this.diagnosis = diagnosis;
    }

    public AnomalyDetector.Params params() {
        AnomalyDetector.Params d = AnomalyDetector.Params.DEFAULTS;
        return new AnomalyDetector.Params(baselines.minSamples(), cfg.getNumber("sqlinsight.anomaly.z", d.z()),
                (int) cfg.getLong("sqlinsight.anomaly.min_exec", d.minExec()), cfg.getNumber("sqlinsight.anomaly.spike_ratio", d.spikeRatio()),
                (int) cfg.getLong("sqlinsight.anomaly.window", d.window()), (int) cfg.getLong("sqlinsight.anomaly.need", d.need()),
                cfg.getNumber("sqlinsight.anomaly.recover_ratio", d.recoverRatio()),
                (int) cfg.getLong("sqlinsight.anomaly.recover_windows", d.recoverWindows()));
    }

    public record Detection(Map<Long, Map<Metric, Baseline>> baselines, Map<Long, Map<AnomalyDetector.Spec, AnomalyDetector.Check>> checks,
                            AnomalyDetector.Params params) {
    }

    /** 单窗口判定，结果写入每行 anomalyFlags（入库前调用） */
    public Detection detect(long instanceId, Map<Long, WindowRow> assetRows, LocalDateTime at) {
        AnomalyDetector.Params p = params();
        Map<Long, Map<Metric, Baseline>> bl = baselines.current(instanceId, at);
        Map<Long, Map<AnomalyDetector.Spec, AnomalyDetector.Check>> checks = new HashMap<>();
        for (Map.Entry<Long, WindowRow> e : assetRows.entrySet()) {
            Map<Metric, Baseline> b = bl.get(e.getKey());
            if (b == null) {
                continue;
            }
            WindowRow r = e.getValue();
            Map<AnomalyDetector.Spec, AnomalyDetector.Check> cs = new HashMap<>();
            int flags = 0;
            for (AnomalyDetector.Spec s : AnomalyDetector.SPECS) {
                AnomalyDetector.Check c = AnomalyDetector.check(s, r.m(s.metric()), b.get(s.metric()), r.d(Counter.EXEC),
                        DeltaEngine.NORMAL.equals(r.quality), p);
                cs.put(s, c);
                if (c.hit()) {
                    flags |= AnomalyDetector.bit(s);
                }
            }
            r.anomalyFlags = flags;
            checks.put(e.getKey(), cs);
        }
        return new Detection(bl, checks, p);
    }

    /** 入库后调用：持续性判断与事件管理 */
    public void process(InstanceDirectory.Inst inst, Detection det, Map<Long, WindowRow> assetRows, Map<Long, Boolean> coreAssets,
                        Timestamp windowStart, Map<String, Object> changeWindow) {
        AnomalyDetector.Params p = det.params();
        boolean inChange = changeWindow != null;
        // 回看 window 个采集周期（原来固定按 1 分钟算：采集间隔改成 5 分钟时只回看到 1 个窗口，持续性判断永远不成立）
        long intervalMs = Math.max(30_000L, cfg.getLong("sqlinsight.collect.interval_sec", 60) * 1000);
        Map<Long, List<Integer>> flags = stats.recentFlags(inst.id(), new Timestamp(windowStart.getTime() - (p.window() - 1) * intervalMs - intervalMs / 2));
        Map<String, Map<String, Object>> open = new HashMap<>();
        for (Map<String, Object> ev : db.query("SELECT * FROM DI_SQL_ANOMALY WHERE INSTANCE_ID=? AND STATUS='OPEN'", inst.id())) {
            open.put(Values.str(ev.get("EVENT_KEY")), ev);
        }
        boolean instanceEventOpen = open.containsKey(instanceKey(inst.id()));
        Set<String> touched = new HashSet<>();

        for (Map.Entry<Long, WindowRow> e : assetRows.entrySet()) {
            long asset = e.getKey();
            WindowRow r = e.getValue();
            Map<AnomalyDetector.Spec, AnomalyDetector.Check> cs = det.checks().get(asset);
            Map<Metric, Baseline> bl = det.baselines().get(asset);
            for (AnomalyDetector.Spec s : AnomalyDetector.SPECS) {
                String key = sqlKey(inst.id(), asset, s);
                Map<String, Object> ev = open.get(key);
                AnomalyDetector.Check c = cs == null ? null : cs.get(s);
                Baseline b = bl == null ? null : bl.get(s.metric());
                Double cur = r.m(s.metric());
                if (ev != null) {
                    touched.add(key);
                    boolean elevated = AnomalyDetector.stillElevated(s, cur, b, p);
                    boolean upgrade = c != null && c.hit() && "SPIKE".equals(ev.get("ANOMALY_TYPE"))
                            && AnomalyDetector.sustained(flags.get(asset), AnomalyDetector.bit(s), p);
                    int recover = elevated ? 0 : Values.toInt(ev.get("RECOVER_COUNT"), 0) + 1;
                    if (recover >= p.recoverWindows()) {
                        resolve(ev, "连续 " + recover + " 个窗口回落到基线 " + p.recoverRatio() + " 倍以内");
                        continue;
                    }
                    String sev = upgrade ? AnomalyDetector.severity(c.ratio(), r.m(Metric.DB_TIME_SHARE)) : Values.str(ev.get("SEVERITY"));
                    // 本窗口没有值（检测被跳过）时保留上次的倍率/Z 分数/占比，不用 NULL 覆盖
                    db.update("UPDATE DI_SQL_ANOMALY SET CURRENT_VALUE=NVL(?, CURRENT_VALUE), PEAK_VALUE=GREATEST(NVL(PEAK_VALUE, 0), NVL(?, 0)), "
                                    + "RATIO=NVL(?, RATIO), Z_SCORE=NVL(?, Z_SCORE), "
                                    + "DB_TIME_SHARE=NVL(?, DB_TIME_SHARE), HIT_COUNT=HIT_COUNT + ?, RECOVER_COUNT=?, LAST_TIME=?, ANOMALY_TYPE=?, SEVERITY=? WHERE ANOMALY_ID=?",
                            num(cur), num(cur), c == null ? null : num(c.ratio()), c == null ? null : num(c.z()), num(r.m(Metric.DB_TIME_SHARE)),
                            c != null && c.hit() ? 1 : 0, recover, windowStart, upgrade ? "SUSTAINED" : ev.get("ANOMALY_TYPE"), sev, ev.get("ANOMALY_ID"));
                    if (upgrade) {
                        afterSustained(inst, Values.toLong(ev.get("ANOMALY_ID"), 0), asset, s, sev, cur, b, c, inChange,
                                instanceEventOpen, Boolean.TRUE.equals(coreAssets.get(asset)));
                    }
                    continue;
                }
                if (c == null || !c.hit()) {
                    continue;
                }
                boolean isSustained = AnomalyDetector.sustained(flags.get(asset), AnomalyDetector.bit(s), p);
                boolean isSpike = c.ratio() >= p.spikeRatio();
                if (!isSustained && !isSpike) {
                    continue;
                }
                String type = isSustained ? "SUSTAINED" : "SPIKE";
                String sev = isSustained ? AnomalyDetector.severity(c.ratio(), r.m(Metric.DB_TIME_SHARE)) : "WARNING";
                Long id = insert(key, "SQL", inst.id(), asset, s, type, sev, inChange, b, cur, c, r.m(Metric.DB_TIME_SHARE), windowStart,
                        String.format("%s %s：当前 %s，基线 %s（%s），%.1f 倍，Z=%.1f", s.metric().label, s.direction() == AnomalyDetector.Direction.UP ? "升高" : "下降",
                                fmt(cur), b == null ? "-" : fmt(b.median()), b == null ? "-" : b.slot(), c.ratio(), c.z()));
                if (id != null) {
                    touched.add(key);
                    if (isSustained) {
                        afterSustained(inst, id, asset, s, sev, cur, b, c, inChange, instanceEventOpen, Boolean.TRUE.equals(coreAssets.get(asset)));
                    }
                }
            }
        }
        // 本窗口未出现的资产：SQL 停止执行超过 30 分钟视为恢复
        for (Map<String, Object> ev : open.values()) {
            String key = Values.str(ev.get("EVENT_KEY"));
            if (!touched.contains(key) && "SQL".equals(ev.get("SCOPE")) && !"SLOW_DEGRADATION".equals(ev.get("ANOMALY_TYPE"))
                    && ev.get("LAST_TIME") instanceof Timestamp t && windowStart.getTime() - t.getTime() > 30 * 60_000L) {
                resolve(ev, "SQL 已 30 分钟未执行");
            }
        }
        mergeInstance(inst, windowStart, inChange);
    }

    private void afterSustained(InstanceDirectory.Inst inst, long anomalyId, long asset, AnomalyDetector.Spec s, String sev, Double cur,
                                Baseline b, AnomalyDetector.Check c, boolean inChange, boolean instanceEventOpen, boolean core) {
        boolean notify = cfg.getBool("sqlinsight.anomaly.notify", false) && !inChange && !instanceEventOpen
                && (!cfg.getBool("sqlinsight.anomaly.notify_core_only", true) || core);
        if (notify) {
            Long alertId = alerts.fire(AlertBridge.RULE_ANOMALY, inst.id(), inst.name(), sev,
                    String.format("[SQL异常波动·持续升高] SQL#%d %s 当前 %s，基线 %s，%.1f 倍", asset, s.metric().label, fmt(cur),
                            b == null ? "-" : fmt(b.median()), c.ratio()));
            if (alertId != null) {
                db.update("UPDATE DI_SQL_ANOMALY SET ALERT_ID=? WHERE ANOMALY_ID=?", alertId, anomalyId);
            }
        }
        if (cfg.getBool("sqlinsight.diagnosis.enabled", true)) {
            diagnosis.diagnoseAsync(anomalyId);
        }
    }

    /** 同一实例同时有大量 SQL 波动 → 合并为一个实例级事件（通常是实例资源问题），SQL 级不再单独告警 */
    private void mergeInstance(InstanceDirectory.Inst inst, Timestamp windowStart, boolean inChange) {
        int threshold = (int) cfg.getLong("sqlinsight.anomaly.instance_merge_threshold", 5);
        long n = db.count("SELECT COUNT(DISTINCT ASSET_ID) FROM DI_SQL_ANOMALY WHERE INSTANCE_ID=? AND STATUS='OPEN' AND SCOPE='SQL' "
                + "AND ANOMALY_TYPE='SUSTAINED' AND LAST_TIME >= ?", inst.id(), windowStart);
        String key = instanceKey(inst.id());
        Map<String, Object> ev = db.one("SELECT * FROM DI_SQL_ANOMALY WHERE EVENT_KEY=? AND STATUS='OPEN'", key);
        if (ev == null && n >= threshold) {
            Long id = null;
            try {
                id = db.insertReturningId("INSERT INTO DI_SQL_ANOMALY (EVENT_KEY, SCOPE, INSTANCE_ID, ANOMALY_TYPE, SEVERITY, IN_CHANGE_WINDOW, "
                                + "CURRENT_VALUE, START_TIME, LAST_TIME, DETAIL) VALUES (?, 'INSTANCE', ?, 'SUSTAINED', 'CRITICAL', ?, ?, ?, ?, ?)", "ANOMALY_ID",
                        key, inst.id(), inChange ? 1 : 0, n, windowStart, windowStart,
                        "同一实例 " + n + " 条 SQL 同时持续升高，疑似实例级资源问题（CPU/IO/锁/参数变更），SQL 级告警已合并");
            } catch (Exception e) {
                if (!Db.isUniqueViolation(e)) {
                    throw e;
                }
            }
            if (id != null) {
                if (cfg.getBool("sqlinsight.anomaly.notify", false) && !inChange) {
                    Long alertId = alerts.fire(AlertBridge.RULE_ANOMALY, inst.id(), inst.name(), "CRITICAL",
                            "[SQL异常波动·实例级] " + n + " 条 SQL 同时持续升高，请检查实例资源");
                    if (alertId != null) {
                        db.update("UPDATE DI_SQL_ANOMALY SET ALERT_ID=? WHERE ANOMALY_ID=?", alertId, id);
                    }
                }
                if (cfg.getBool("sqlinsight.diagnosis.enabled", true)) {
                    diagnosis.diagnoseAsync(id);
                }
            }
        } else if (ev != null) {
            if (n <= 1) {
                resolve(ev, "同时波动的 SQL 已回落");
            } else {
                db.update("UPDATE DI_SQL_ANOMALY SET CURRENT_VALUE=?, PEAK_VALUE=GREATEST(NVL(PEAK_VALUE, 0), NVL(?, 0)), LAST_TIME=?, HIT_COUNT=HIT_COUNT+1 "
                        + "WHERE ANOMALY_ID=?", n, n, windowStart, ev.get("ANOMALY_ID"));
            }
        }
    }

    /** 缓慢劣化（每小时随基线刷新） */
    public void processDegradations(InstanceDirectory.Inst inst, List<BaselineService.Degradation> list) {
        Set<String> keys = new HashSet<>();
        Timestamp now = new Timestamp(System.currentTimeMillis());
        for (BaselineService.Degradation d : list) {
            String key = inst.id() + "|" + d.assetId() + "|" + d.metric().key + "|SLOW";
            keys.add(key);
            int n = db.update("UPDATE DI_SQL_ANOMALY SET CURRENT_VALUE=?, RATIO=?, LAST_TIME=?, HIT_COUNT=HIT_COUNT+1 WHERE EVENT_KEY=? AND STATUS='OPEN'",
                    num(d.recent()), num(d.ratio()), now, key);
            if (n > 0) {
                continue;
            }
            try {
                Long id = db.insertReturningId("INSERT INTO DI_SQL_ANOMALY (EVENT_KEY, SCOPE, INSTANCE_ID, ASSET_ID, METRIC, DIRECTION, ANOMALY_TYPE, SEVERITY, "
                                + "BASELINE_VALUE, CURRENT_VALUE, PEAK_VALUE, RATIO, START_TIME, LAST_TIME, DETAIL) VALUES (?, 'SQL', ?, ?, ?, 'UP', 'SLOW_DEGRADATION', "
                                + "'WARNING', ?, ?, ?, ?, ?, ?, ?)", "ANOMALY_ID", key, inst.id(), d.assetId(), d.metric().key, num(d.base()),
                        num(d.recent()), num(d.recent()), num(d.ratio()), now, now,
                        String.format("%s 连续 3 天高于历史 %.1f 倍（近 3 天日中位数 %s；历史 %s）", d.metric().label, d.ratio(),
                                d.lastDays().stream().map(AnomalyService::fmt).toList(), fmt(d.base())));
                if (id != null && cfg.getBool("sqlinsight.diagnosis.enabled", true)) {
                    diagnosis.diagnoseAsync(id);
                }
            } catch (Exception e) {
                if (!Db.isUniqueViolation(e)) {
                    throw e;
                }
            }
        }
        for (Map<String, Object> ev : db.query("SELECT ANOMALY_ID, EVENT_KEY, ALERT_ID FROM DI_SQL_ANOMALY WHERE INSTANCE_ID=? AND STATUS='OPEN' "
                + "AND ANOMALY_TYPE='SLOW_DEGRADATION'", inst.id())) {
            if (!keys.contains(Values.str(ev.get("EVENT_KEY")))) {
                resolve(ev, "缓慢劣化趋势已消失");
            }
        }
    }

    // ------------------------------------------------------------------ 人工操作

    /** 接受为新基线：事件关闭，基线从现在重算（期间该 SQL 的该类波动不再告警，直到新基线样本足够） */
    public void accept(long anomalyId, String operator, String note) {
        Map<String, Object> ev = db.one("SELECT * FROM DI_SQL_ANOMALY WHERE ANOMALY_ID=?", anomalyId);
        if (ev == null) {
            throw com.dbops.common.BizException.notFound("事件不存在");
        }
        Long asset = Values.toLong(ev.get("ASSET_ID"));
        if (asset != null) {
            baselines.anchor(Values.toLong(ev.get("INSTANCE_ID")), asset, "ACCEPT_NEW", operator, note);
        }
        db.update("UPDATE DI_SQL_ANOMALY SET STATUS='ACCEPTED', RESOLVED_AT=SYSTIMESTAMP, DETAIL=SUBSTR(DETAIL || ' | 已接受为新基线：' || ?, 1, 2000) "
                + "WHERE ANOMALY_ID=? AND STATUS='OPEN'", Values.str(note, operator), anomalyId);
        alerts.resolve(ev.get("ALERT_ID"), "SQL 波动已被接受为新基线（" + operator + "）");
    }

    public void resolveManually(long anomalyId, String operator) {
        Map<String, Object> ev = db.one("SELECT ANOMALY_ID, ALERT_ID FROM DI_SQL_ANOMALY WHERE ANOMALY_ID=? AND STATUS='OPEN'", anomalyId);
        if (ev != null) {
            resolve(ev, "人工关闭（" + operator + "）");
        }
    }

    private void resolve(Map<String, Object> ev, String why) {
        db.update("UPDATE DI_SQL_ANOMALY SET STATUS='RESOLVED', RESOLVED_AT=SYSTIMESTAMP WHERE ANOMALY_ID=? AND STATUS='OPEN'", ev.get("ANOMALY_ID"));
        alerts.resolve(ev.get("ALERT_ID"), "SQL 波动已恢复：" + why);
    }

    private Long insert(String key, String scope, long instanceId, long asset, AnomalyDetector.Spec s, String type, String sev, boolean inChange,
                        Baseline b, Double cur, AnomalyDetector.Check c, Double share, Timestamp at, String detail) {
        try {
            return db.insertReturningId("INSERT INTO DI_SQL_ANOMALY (EVENT_KEY, SCOPE, INSTANCE_ID, ASSET_ID, METRIC, DIRECTION, ANOMALY_TYPE, SEVERITY, "
                            + "IN_CHANGE_WINDOW, BASELINE_VALUE, CURRENT_VALUE, PEAK_VALUE, RATIO, Z_SCORE, DB_TIME_SHARE, START_TIME, LAST_TIME, DETAIL) "
                            + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", "ANOMALY_ID", key, scope, instanceId, asset,
                    s.metric().key, s.direction().name(), type, sev, inChange ? 1 : 0, b == null ? null : num(b.median()), num(cur), num(cur),
                    num(c.ratio()), num(c.z()), num(share), at, at, Values.truncate(detail, 2000));
        } catch (Exception e) {
            if (Db.isUniqueViolation(e)) {
                return null;
            }
            throw e;
        }
    }

    public static String sqlKey(long instanceId, long assetId, AnomalyDetector.Spec s) {
        return instanceId + "|" + assetId + "|" + s.metric().key + "|" + s.direction().name();
    }

    public static String instanceKey(long instanceId) {
        return instanceId + "|" + INSTANCE_SCOPE_KEY + "|INSTANCE";
    }

    static Object num(Double v) {
        return v == null || v.isNaN() || v.isInfinite() ? null : Values.round(v, 6);
    }

    static String fmt(Double v) {
        if (v == null || v.isNaN()) {
            return "-";
        }
        if (Math.abs(v) >= 100) {
            return String.format("%.0f", v);
        }
        return String.format("%.3g", v);
    }

    /** 本窗口参与检测的资产（供调用方判断是否需要处理） */
    public static List<Long> assets(Map<Long, WindowRow> rows) {
        return new ArrayList<>(rows.keySet());
    }
}
