package com.dbops.sqlinsight;

import com.dbops.config.DbopsProperties;
import com.dbops.service.SystemConfigService;
import com.dbops.sqlinsight.anomaly.AnomalyService;
import com.dbops.sqlinsight.baseline.BaselineService;
import com.dbops.sqlinsight.collect.SqlCollectService;
import com.dbops.sqlinsight.collect.SlowSqlService;
import com.dbops.sqlinsight.store.InstanceDirectory;
import com.dbops.sqlinsight.store.StatsRepo;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * SQL 洞察调度：与监控调度器共用 MONITOR_SCHEDULER_ENABLED（Java 接管后 Node 侧关闭即可，不会双采），
 * 各阶段再由 SYS_CONFIG 的 sqlinsight.* 开关控制。
 * <ul>
 *   <li>分钟采集：每 sqlinsight.collect.interval_sec（默认 60s）一轮，实例并发度 sqlinsight.collect.parallel</li>
 *   <li>活动会话采样：每 sqlinsight.sampler.interval_sec（默认 15s）</li>
 *   <li>慢 SQL 快照：每 sqlinsight.slow.capture_interval_min（默认 30 分钟）一批，写 SQL_SLOW_SUMMARY</li>
 *   <li>每小时：基线刷新 + 缓慢劣化判断 + 过期数据清理</li>
 * </ul>
 */
@Component
public class SqlInsightScheduler {

    private static final Logger log = LoggerFactory.getLogger(SqlInsightScheduler.class);

    private final SqlCollectService collect;
    private final SlowSqlService slowSql;
    private volatile long lastSlowRound;
    private final BaselineService baselines;
    private final AnomalyService anomalies;
    private final InstanceDirectory instances;
    private final StatsRepo stats;
    private final SystemConfigService cfg;
    private final boolean enabled;
    private final com.dbops.license.LicenseService license;
    private final ScheduledExecutorService ses = Executors.newScheduledThreadPool(3, r -> {
        Thread t = new Thread(r, "sqlinsight-scheduler");
        t.setDaemon(true);
        return t;
    });
    // 有界队列 + 同一任务（类型+实例）排队中不重复入队：原来是无界队列，实例多/目标库慢时
    // 每轮都给同一实例再排一个任务，队列越积越长、内存上涨、采集严重滞后
    private final ThreadPoolExecutor workers = new ThreadPoolExecutor(4, 4, 60, TimeUnit.SECONDS, new LinkedBlockingQueue<>(2000), r -> {
        Thread t = new Thread(r, "sqlinsight-worker");
        t.setDaemon(true);
        return t;
    }, new ThreadPoolExecutor.AbortPolicy());
    private final java.util.Set<String> queued = java.util.concurrent.ConcurrentHashMap.newKeySet();

    /** 同一 key 已在排队则跳过；队列满则本轮跳过（下一轮会再来） */
    private void submitOnce(String key, Runnable job) {
        if (!queued.add(key)) {
            return;
        }
        try {
            workers.execute(() -> {
                queued.remove(key);
                job.run();
            });
        } catch (java.util.concurrent.RejectedExecutionException e) {
            queued.remove(key);
        }
    }
    private final AtomicBoolean hourly = new AtomicBoolean(false);
    private final com.dbops.sqlinsight.plan.RetestService retests;
    private volatile boolean rollupSeeded = false;

    public SqlInsightScheduler(SqlCollectService collect, BaselineService baselines, AnomalyService anomalies, InstanceDirectory instances,
                               StatsRepo stats, SystemConfigService cfg, DbopsProperties props, SlowSqlService slowSql,
                               com.dbops.license.LicenseService license, com.dbops.sqlinsight.plan.RetestService retests) {
        this.license = license;
        this.retests = retests;
        this.collect = collect;
        this.slowSql = slowSql;
        this.baselines = baselines;
        this.anomalies = anomalies;
        this.instances = instances;
        this.stats = stats;
        this.cfg = cfg;
        this.enabled = props.getMonitor().isSchedulerEnabled();
    }

    @EventListener(ApplicationReadyEvent.class)
    public void start() {
        if (!enabled) {
            log.info("[sqlinsight] scheduler disabled (MONITOR_SCHEDULER_ENABLED=false)");
            return;
        }
        int parallel = (int) Math.max(1, Math.min(32, cfg.getLong("sqlinsight.collect.parallel", 4)));
        workers.setMaximumPoolSize(Math.max(parallel, workers.getCorePoolSize()));
        workers.setCorePoolSize(parallel);
        workers.setMaximumPoolSize(parallel);
        long interval = Math.max(30, cfg.getLong("sqlinsight.collect.interval_sec", 60));
        long sampler = Math.max(5, cfg.getLong("sqlinsight.sampler.interval_sec", 15));
        // 对齐到整分钟后 5 秒，让窗口起点稳定
        long delay = 65_000 - System.currentTimeMillis() % 60_000;
        ses.scheduleAtFixedRate(this::collectRound, delay, interval * 1000, TimeUnit.MILLISECONDS);
        ses.scheduleWithFixedDelay(this::sampleRound, 20_000, sampler * 1000, TimeUnit.MILLISECONDS);
        ses.scheduleWithFixedDelay(this::hourlyRound, 10 * 60_000L, 3600_000L, TimeUnit.MILLISECONDS);
        ses.scheduleWithFixedDelay(this::slowRound, 3 * 60_000L, 60_000L, TimeUnit.MILLISECONDS);
        log.info("[sqlinsight] scheduler started: collect {}s, sampler {}s, parallel {}", interval, sampler, parallel);
    }

    @PreDestroy
    public void stop() {
        ses.shutdownNow();
        workers.shutdownNow();
    }

    void collectRound() {
        if (!license.backgroundAllowed()) {
            return;   // 授权到期超过宽限期：SQL 采集 / 检测停止
        }
        if (!cfg.getBool("sqlinsight.collect.enabled", true)) {
            return;
        }
        try {
            for (InstanceDirectory.Inst i : instances.collectable()) {
                if (!collect.isRunning(i.id())) {
                    submitOnce("collect:" + i.id(), () -> collect.collect(i.id()));
                }
            }
        } catch (Exception e) {
            log.warn("[sqlinsight] collect round: {}", e.getMessage());
        }
    }

    void sampleRound() {
        if (!license.backgroundAllowed()) {
            return;   // 授权到期超过宽限期：SQL 采集 / 检测停止
        }
        if (!cfg.getBool("sqlinsight.collect.enabled", true) || !cfg.getBool("sqlinsight.rules.enabled", true)) {
            return;
        }
        try {
            for (InstanceDirectory.Inst i : instances.collectable()) {
                submitOnce("sample:" + i.id(), () -> collect.sampleSessions(i.id()));
            }
        } catch (Exception e) {
            log.warn("[sqlinsight] sampler round: {}", e.getMessage());
        }
    }

    /** 定时慢 SQL 快照：每 sqlinsight.slow.capture_interval_min 分钟一批（0 = 只手动采集） */
    void slowRound() {
        if (!license.backgroundAllowed()) {
            return;   // 授权到期超过宽限期：SQL 采集 / 检测停止
        }
        long intervalMin = cfg.getLong("sqlinsight.slow.capture_interval_min", 30);
        if (intervalMin <= 0 || System.currentTimeMillis() - lastSlowRound < intervalMin * 60_000L - 5_000L) {
            return;
        }
        lastSlowRound = System.currentTimeMillis();
        try {
            for (InstanceDirectory.Inst i : instances.collectable()) {
                if (!slowSql.isRunning(i.id())) {
                    submitOnce("slow:" + i.id(), () -> {
                        try {
                            slowSql.capture(i.id(), "SCHEDULE", null);
                        } catch (Exception e) {
                            log.warn("[sqlinsight] slow capture inst={}: {}", i.id(), e.getMessage());
                        }
                    });
                }
            }
        } catch (Exception e) {
            log.warn("[sqlinsight] slow round: {}", e.getMessage());
        }
    }

    void hourlyRound() {
        if (!license.backgroundAllowed()) {
            return;   // 授权到期超过宽限期：SQL 采集 / 检测停止
        }
        if (!hourly.compareAndSet(false, true)) {
            return;
        }
        try {
            boolean anomalyOn = cfg.getBool("sqlinsight.anomaly.enabled", true);
            for (InstanceDirectory.Inst i : instances.collectable()) {
                try {
                    if (anomalyOn) {
                        baselines.refresh(i.id());
                        anomalies.processDegradations(i, baselines.slowDegradation(i.id(), cfg.getNumber("sqlinsight.anomaly.degradation_ratio", 1.5)));
                    }
                } catch (Exception e) {
                    log.warn("[sqlinsight] hourly inst={}: {}", i.id(), e.getMessage());
                }
            }
            try {
                // 小时汇总：首轮用分钟数据保留期回填，之后每小时刷新最近 3 小时
                int statsDays = (int) cfg.getLong("sqlinsight.retention.stats_days", 35);
                stats.rollupHours(rollupSeeded ? 3 : statsDays * 24);
                rollupSeeded = true;
                stats.purgeRollup((int) cfg.getLong("sqlinsight.retention.rollup_days", 400));
            } catch (Exception e) {
                log.warn("[sqlinsight] rollup: {}", e.getMessage());
            }
            try {
                retests.syncTickets();
                retests.autoFinish((int) cfg.getLong("sqlinsight.retest.auto_finish_hours", 72));
            } catch (Exception e) {
                log.warn("[sqlinsight] retest round: {}", e.getMessage());
            }
            int purged = stats.purge((int) cfg.getLong("sqlinsight.retention.stats_days", 35));
            try {
                purged += slowSql.purge((int) cfg.getLong("sqlinsight.retention.slow_days", 30));
            } catch (Exception e) {
                log.warn("[sqlinsight] purge slow sql: {}", e.getMessage());
            }
            if (purged > 0) {
                log.info("[sqlinsight] purged {} stats rows", purged);
            }
        } catch (Exception e) {
            log.warn("[sqlinsight] hourly round: {}", e.getMessage());
        } finally {
            hourly.set(false);
        }
    }
}
