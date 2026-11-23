package com.dbops.monitor;

import com.dbops.alert.AlertPolicyService;
import com.dbops.common.Db;
import com.dbops.common.Values;
import com.dbops.config.DbopsProperties;
import com.dbops.service.SystemConfigService;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.sql.Timestamp;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 监控定时任务（对应 Node app.js 中的 scheduleCollect + monitorInstanceCollectScheduler.js）：
 * <ul>
 *   <li>全量采集：每 interval（默认 90s，最小 60s）一轮，上一轮结束后再计时（不会重叠）</li>
 *   <li>实例级采集：每 15s 检查 COLLECT_INTERVAL_SEC &gt; 0 且到期的实例</li>
 *   <li>每轮全量采集后：集群汇总 + 告警策略（静默/抑制/聚合）</li>
 * </ul>
 * 由 MONITOR_SCHEDULER_ENABLED 控制；Java 接管后 Node 侧需设置 MONITOR_SCHEDULER_ENABLED=false。
 */
@Component
public class CollectScheduler {

    private static final Logger log = LoggerFactory.getLogger(CollectScheduler.class);
    private static final long TICK_MS = 15_000;

    private final CollectService collect;
    private final ClusterRollupService cluster;
    private final AlertPolicyService policies;
    private final SystemConfigService cfg;
    private final Db db;
    private final boolean enabled;
    private final com.dbops.license.LicenseService license;
    private final ScheduledExecutorService ses = Executors.newScheduledThreadPool(2, r -> {
        Thread t = new Thread(r, "monitor-scheduler");
        t.setDaemon(true);
        return t;
    });
    private final AtomicBoolean ticking = new AtomicBoolean(false);

    public CollectScheduler(CollectService collect, ClusterRollupService cluster, AlertPolicyService policies,
                            SystemConfigService cfg, Db db, DbopsProperties props,
                            com.dbops.license.LicenseService license) {
        this.license = license;
        this.collect = collect;
        this.cluster = cluster;
        this.policies = policies;
        this.cfg = cfg;
        this.db = db;
        this.enabled = props.getMonitor().isSchedulerEnabled();
    }

    @EventListener(ApplicationReadyEvent.class)
    public void start() {
        cfg.loadAll();
        if (!enabled) {
            log.info("[monitor-scheduler] disabled (MONITOR_SCHEDULER_ENABLED=false)");
            return;
        }
        long firstDelay = Math.max(1000, cfg.getLong("monitor.collect.first_delay_ms", 8000));
        ses.schedule(this::round, firstDelay, TimeUnit.MILLISECONDS);
        ses.scheduleWithFixedDelay(this::tickInstances, 5000, TICK_MS, TimeUnit.MILLISECONDS);
        log.info("[monitor-scheduler] interval {}ms, first delay {}ms; per-instance tick {}ms", collect.intervalMs(), firstDelay, TICK_MS);
    }

    @PreDestroy
    public void stop() {
        ses.shutdownNow();
    }

    private void round() {
        try {
            if (!license.backgroundAllowed()) {
                log.warn("[monitor-scheduler] 授权到期超过宽限期，监控采集与告警已停止");
                return;
            }
            collect.collectAll(() -> {
                try {
                    cluster.run();
                } catch (Exception e) {
                    log.warn("[monitor-collect] clusterRollup: {}", e.getMessage());
                }
                try {
                    policies.applyOpenAlertPolicies();
                } catch (Exception e) {
                    log.warn("[monitor-collect] alert policies: {}", e.getMessage());
                }
            });
        } catch (Exception e) {
            log.error("[monitor-scheduler] {}", e.getMessage());
        } finally {
            if (!ses.isShutdown()) {
                ses.schedule(this::round, collect.intervalMs(), TimeUnit.MILLISECONDS);
            }
        }
    }

    private void tickInstances() {
        if (!license.backgroundAllowed() || !ticking.compareAndSet(false, true)) {
            return;
        }
        try {
            List<Map<String, Object>> rows;
            try {
                rows = db.query("SELECT INSTANCE_ID, COLLECT_INTERVAL_SEC, LAST_CHECK FROM CMDB_INSTANCE "
                        + "WHERE NVL(COLLECT_INTERVAL_SEC, 0) > 0 AND NVL(STATUS, 'UNKNOWN') <> 'STOPPED'");
            } catch (Exception e) {
                if (Db.isMissingColumn(e)) {
                    return;
                }
                throw e;
            }
            long now = System.currentTimeMillis();
            for (Map<String, Object> r : rows) {
                long id = Values.toLong(r.get("INSTANCE_ID"), 0);
                long sec = Values.toLong(r.get("COLLECT_INTERVAL_SEC"), 0);
                long last = r.get("LAST_CHECK") instanceof Timestamp ts ? ts.getTime() : 0;
                if (sec > 0 && (last == 0 || now - last >= sec * 1000) && !collect.isCollecting(id)) {
                    collect.submit(id);
                }
            }
        } catch (Exception e) {
            log.warn("[monitor-instance-scheduler] tick: {}", e.getMessage());
        } finally {
            ticking.set(false);
        }
    }
}
