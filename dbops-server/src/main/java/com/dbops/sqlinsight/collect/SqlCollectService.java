package com.dbops.sqlinsight.collect;

import com.dbops.common.Values;
import com.dbops.monitor.TargetConnector;
import com.dbops.monitor.TargetDb;
import com.dbops.service.SystemConfigService;
import com.dbops.sqlinsight.anomaly.AnomalyService;
import com.dbops.sqlinsight.rules.ProblemService;
import com.dbops.sqlinsight.rules.RuleConfigService;
import com.dbops.sqlinsight.rules.RuntimeRuleEngine;
import com.dbops.sqlinsight.store.AssetService;
import com.dbops.sqlinsight.store.InstanceDirectory;
import com.dbops.sqlinsight.store.StatsRepo;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 每分钟一轮的 SQL 采集主流程（设计方案第 3 节）：
 * <pre>
 * 能力探测(6h 缓存) → 累计快照 → 增量/数据质量 → 资产指纹 → 变更窗口标记
 *   → 单窗口波动判定(写 flags) → 分钟统计入库(幂等) → 运行态规则 → 事件管理/告警/诊断
 * </pre>
 * 活动会话采样（P-001/P-002/P-010）单独 15 秒一次。
 */
@Service
public class SqlCollectService {

    private static final Logger log = LoggerFactory.getLogger(SqlCollectService.class);
    private static final long PROBE_TTL_MS = 6 * 3600_000L;

    private final TargetConnector connector;
    private final InstanceDirectory instances;
    private final AssetService assets;
    private final StatsRepo stats;
    private final RuleConfigService rules;
    private final ProblemService problems;
    private final AnomalyService anomalies;
    private final SystemConfigService cfg;
    private final DeltaEngine delta = new DeltaEngine();
    private final Map<Long, StatsSource.Probe> probes = new ConcurrentHashMap<>();
    private final Map<Long, Long> probedAt = new ConcurrentHashMap<>();
    private final Set<Long> running = ConcurrentHashMap.newKeySet();
    private final Set<Long> sampling = ConcurrentHashMap.newKeySet();
    /** 会话规则连续命中计数：实例 → (规则|会话键 → 次数) */
    private final Map<Long, Map<String, Integer>> sessionStreak = new ConcurrentHashMap<>();
    private final Map<Long, String> lastError = new ConcurrentHashMap<>();

    public SqlCollectService(TargetConnector connector, InstanceDirectory instances, AssetService assets, StatsRepo stats,
                             RuleConfigService rules, ProblemService problems, AnomalyService anomalies, SystemConfigService cfg) {
        this.connector = connector;
        this.instances = instances;
        this.assets = assets;
        this.stats = stats;
        this.rules = rules;
        this.problems = problems;
        this.anomalies = anomalies;
        this.cfg = cfg;
    }

    public boolean isRunning(long instanceId) {
        return running.contains(instanceId);
    }

    public String lastError(long instanceId) {
        return lastError.get(instanceId);
    }

    public void reprobe(long instanceId) {
        probedAt.remove(instanceId);
    }

    // ------------------------------------------------------------------ 分钟采集

    public Map<String, Object> collect(long instanceId) {
        InstanceDirectory.Inst inst = instances.get(instanceId);
        if (inst == null) {
            throw com.dbops.common.BizException.notFound("实例不存在");
        }
        if (!running.add(instanceId)) {
            return Map.of("skipped", "上一轮采集仍在进行");
        }
        long t0 = System.currentTimeMillis();
        Map<String, Object> summary = new LinkedHashMap<>();
        try (TargetDb tdb = connector.open(instanceId)) {
            StatsSource.Probe probe = probe(inst, tdb);
            summary.put("source", probe.spec() == null ? null : probe.spec().sourceName());
            if (!probe.ok()) {
                summary.put("error", probe.error());
                lastError.put(instanceId, probe.error());
                return summary;
            }
            int topN = (int) cfg.getLong("sqlinsight.collect.top_n", 1000);
            List<SqlCounters> snap = StatsSource.snapshot(tdb, probe, topN);
            long now = System.currentTimeMillis();
            long interval = Math.max(30_000L, cfg.getLong("sqlinsight.collect.interval_sec", 60) * 1000);
            DeltaEngine.Result dr = delta.compute(instanceId, snap, now, interval, probe.activityFiltered());
            summary.put("snapshot", snap.size());
            summary.put("baseline", dr.baseline());
            summary.put("reset", dr.reset());
            summary.put("gap", dr.gap());
            summary.put("idle", dr.idle());
            Timestamp windowStart = Timestamp.from(Instant.ofEpochMilli(now).truncatedTo(ChronoUnit.MINUTES));
            int stored = processWindow(inst, dr.rows(), windowStart, summary);
            summary.put("stored", stored);
            lastError.remove(instanceId);
        } catch (Exception e) {
            delta.forget(instanceId);
            lastError.put(instanceId, Values.truncate(e.getMessage(), 500));
            summary.put("error", e.getMessage());
            log.warn("[sqlinsight] collect inst={} failed: {}", instanceId, e.getMessage());
        } finally {
            running.remove(instanceId);
        }
        summary.put("costMs", System.currentTimeMillis() - t0);
        return summary;
    }

    StatsSource.Probe probe(InstanceDirectory.Inst inst, TargetDb tdb) {
        Long at = probedAt.get(inst.id());
        StatsSource.Probe p = probes.get(inst.id());
        // 探测失败只缓存 5 分钟（原来失败也缓存 6 小时：授权/网络问题修好后要等 6 小时才恢复采集）
        long ttl = p != null && !p.ok() ? 5 * 60_000L : PROBE_TTL_MS;
        if (p != null && at != null && System.currentTimeMillis() - at < ttl) {
            return p;
        }
        StatsSource.Spec spec = StatsSource.spec(inst.dbType(), cfg.getNumber("sqlinsight.panwei.time_divisor", 1000),
                cfg.getNumber("sqlinsight.dameng.time_divisor", 1));
        if (spec == null) {
            p = new StatsSource.Probe(null, false, "不支持的数据库类型: " + inst.dbType(), List.of(), null, null, null, Map.of(), List.of(), null);
        } else {
            p = StatsSource.probe(tdb, spec);
        }
        try {
            stats.saveCapability(inst.id(), p.ok() ? p.capability() : StatsSource.noneCapability(),
                    spec == null ? null : spec.sourceName(), p.error());
        } catch (Exception e) {
            log.warn("[sqlinsight] save capability inst={}: {}", inst.id(), e.getMessage());
        }
        probes.put(inst.id(), p);
        probedAt.put(inst.id(), System.currentTimeMillis());
        return p;
    }

    /** 窗口处理（与连接无关，单测可直接喂 WindowRow） */
    int processWindow(InstanceDirectory.Inst inst, List<WindowRow> rows, Timestamp windowStart, Map<String, Object> summary) {
        if (rows.isEmpty()) {
            problems.resolveStale(inst.id(), 30);
            return 0;
        }
        // 1) 资产
        Map<Long, List<String>> nativeIds = new HashMap<>();
        Map<Long, Boolean> core = new HashMap<>();
        Map<Long, String> bizOf = new HashMap<>();
        for (WindowRow r : rows) {
            AssetService.AssetRef a = assets.resolveNative(inst.id(), r.cur.nativeId(), inst.dbType(), r.cur.schema(), r.cur.sqlText());
            r.assetId = a.assetId();
            core.put(a.assetId(), a.core());
            if (a.bizType() != null && InstanceDirectory.BIZ_TYPES.contains(a.bizType())) {
                bizOf.put(a.assetId(), a.bizType());
            }
            nativeIds.computeIfAbsent(a.assetId(), k -> new ArrayList<>()).add(r.cur.nativeId());
        }
        assets.touchSources(inst.id(), nativeIds);
        assets.touchLastSeen(nativeIds.keySet());

        // 2) 变更窗口：窗口内数据入库但不进基线、不告警
        Map<String, Object> change = stats.activeChangeWindow(inst.id());
        if (change != null) {
            rows.forEach(r -> r.excludeBaseline = true);
            summary.put("changeWindow", change.get("TITLE"));
        }

        // 3) 合并：入库粒度 (资产, 计划)；规则/检测粒度 资产
        double total = 0;
        for (WindowRow r : rows) {
            double e = r.d(Counter.ELAPSED_MS);
            total += Double.isNaN(e) ? 0 : e;
        }
        Map<String, List<WindowRow>> byPlan = new LinkedHashMap<>();
        Map<Long, List<WindowRow>> byAsset = new LinkedHashMap<>();
        for (WindowRow r : rows) {
            byPlan.computeIfAbsent(r.assetId + "#" + r.cur.planHash(), k -> new ArrayList<>()).add(r);
            byAsset.computeIfAbsent(r.assetId, k -> new ArrayList<>()).add(r);
        }
        List<WindowRow> planRows = new ArrayList<>();
        for (List<WindowRow> g : byPlan.values()) {
            planRows.add(WindowRow.merge(g, total));
        }
        Map<Long, WindowRow> assetRows = new LinkedHashMap<>();
        for (Map.Entry<Long, List<WindowRow>> e : byAsset.entrySet()) {
            assetRows.put(e.getKey(), WindowRow.merge(e.getValue(), total));
        }

        // 4) 单窗口波动判定（flags 随统计一起入库，作为持续性判断的状态）
        boolean anomalyOn = cfg.getBool("sqlinsight.anomaly.enabled", true);
        AnomalyService.Detection det = null;
        if (anomalyOn) {
            det = anomalies.detect(inst.id(), assetRows, LocalDateTime.ofInstant(windowStart.toInstant(), ZoneId.systemDefault()));
            for (WindowRow r : planRows) {
                WindowRow a = assetRows.get(r.assetId);
                r.anomalyFlags = a == null ? 0 : a.anomalyFlags;
            }
        }

        // 5) 入库
        String batchId = inst.id() + "-" + windowStart.getTime() / 60000;
        int stored = stats.insertWindow(inst.id(), windowStart, batchId, planRows);

        // 6) 运行态规则
        if (cfg.getBool("sqlinsight.rules.enabled", true)) {
            Timestamp since = new Timestamp(windowStart.getTime() - 10 * 60_000L);
            Map<Long, List<Double>> shares = stats.recentColumn(inst.id(), "DB_TIME_SHARE", since);
            Map<Long, List<Double>> tmp = stats.recentColumn(inst.id(), "D_TMP_DISK", since);
            Map<Long, Long> nat = stats.nativeIdCounts(inst.id(), new ArrayList<>(assetRows.keySet()));
            StatsSource.Probe p = probes.get(inst.id());
            RuntimeRuleEngine.Ctx ctx = new RuntimeRuleEngine.Ctx(
                    (code, asset) -> rules.resolve(code, new RuleConfigService.Scope(asset, inst.id(), bizOf.getOrDefault(asset, inst.bizType()), inst.family())),
                    c -> p != null && p.supports(c),
                    a -> tail(shares.get(a)), a -> tail(tmp.get(a)), nat::get);
            RuntimeRuleEngine.Result res = RuntimeRuleEngine.evaluateWindow(new ArrayList<>(assetRows.values()), ctx);
            int opened = problems.applyWindow(inst, res, assetRows.keySet());
            problems.resolveStale(inst.id(), 30);
            summary.put("problemsOpened", opened);
            summary.put("hits", res.hits().size());
        }

        // 7) 事件管理
        if (anomalyOn && det != null) {
            anomalies.process(inst, det, assetRows, core, windowStart, change);
        }
        return stored;
    }

    /** recentColumn 返回含本窗口（新→旧），规则需要“之前的窗口” */
    private static List<Double> tail(List<Double> l) {
        return l == null || l.isEmpty() ? List.of() : l.subList(1, l.size());
    }

    // ------------------------------------------------------------------ 活动会话采样

    /** 每次采样：所有带 SQL 的活动会话按 (资产, 等待事件) 累计；无等待事件记为 ON CPU。失败不影响后续规则判定 */
    private void recordWaits(long instanceId, InstanceDirectory.Inst inst, List<ActiveSession> sessions) {
        try {
            Map<Long, Map<String, double[]>> byAsset = new HashMap<>();
            for (ActiveSession s : sessions) {
                if (s.sqlText() == null || s.sqlText().isBlank()) {
                    continue;
                }
                String nid = s.nativeId() != null ? s.nativeId() : "TXT:" + Integer.toHexString(s.sqlText().hashCode());
                long a = assets.resolveNative(instanceId, nid, inst.dbType(), s.schema(), s.sqlText()).assetId();
                String ev = s.waitEvent() == null || s.waitEvent().isBlank() ? "ON CPU" : s.waitEvent().trim();
                double[] acc = byAsset.computeIfAbsent(a, k -> new HashMap<>()).computeIfAbsent(ev, k -> new double[2]);
                acc[0] += 1;
                acc[1] += s.waitSec();
            }
            stats.saveWaits(instanceId, byAsset);
        } catch (Exception e) {
            log.debug("[sqlinsight] wait sample inst={}: {}", instanceId, e.getMessage());
        }
    }

    public Map<String, Object> sampleSessions(long instanceId) {
        InstanceDirectory.Inst inst = instances.get(instanceId);
        if (inst == null || !sampling.add(instanceId)) {
            return Map.of();
        }
        try (TargetDb tdb = connector.open(instanceId)) {
            List<ActiveSession> sessions;
            try {
                sessions = SessionSampler.sample(tdb, inst.dbType(), 500);
            } catch (Exception e) {
                stats.saveCapability(instanceId, "active_session", false, "session", Values.truncate(e.getMessage(), 900));
                problems.applySessions(inst, List.of(), false, "活动会话视图不可用：" + Values.truncate(e.getMessage(), 300));
                return Map.of("error", Values.str(e.getMessage(), ""));
            }
            recordWaits(instanceId, inst, sessions);
            Map<String, Integer> streak = sessionStreak.computeIfAbsent(instanceId, k -> new ConcurrentHashMap<>());
            List<RuntimeRuleEngine.SessionHit> hits = RuntimeRuleEngine.evaluateSessions(sessions,
                    s -> {
                        if (s.sqlText() == null || s.sqlText().isBlank()) {
                            return 0L;
                        }
                        String nid = s.nativeId() != null ? s.nativeId() : "TXT:" + Integer.toHexString(s.sqlText().hashCode());
                        return assets.resolveNative(instanceId, nid, inst.dbType(), s.schema(), s.sqlText()).assetId();
                    },
                    (code, asset) -> rules.resolve(code, new RuleConfigService.Scope(asset, inst.id(), inst.bizType(), inst.family())),
                    k -> streak.getOrDefault(k, 0));
            Map<String, Integer> next = new HashMap<>();
            for (RuntimeRuleEngine.SessionHit h : hits) {
                String k = h.code() + "|" + h.sessionKey();
                next.put(k, streak.getOrDefault(k, 0) + 1);
            }
            streak.clear();
            streak.putAll(next);
            problems.applySessions(inst, hits, true, null);
            return Map.of("sessions", sessions.size(), "hits", hits.stream().filter(h -> h.severity() != null).count());
        } catch (Exception e) {
            return Map.of("error", Values.str(e.getMessage(), ""));
        } finally {
            sampling.remove(instanceId);
        }
    }
}
