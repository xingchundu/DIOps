package com.dbops.platform.notify;

import com.dbops.service.SystemConfigService;
import org.springframework.stereotype.Component;

/**
 * 阶段1交付模块配置（读取 SYS_CONFIG，不耦合其他模块业务）。
 * 修改者: dxc | 时间: 2026-11-12
 */
@Component
public class NotifyProperties {

    private final SystemConfigService cfg;

    public NotifyProperties(SystemConfigService cfg) {
        this.cfg = cfg;
    }

    private boolean platformOn() {
        return cfg.getBool("platform.enabled", cfg.getBool("phase3.delivery.enabled", false));
    }

    public boolean deliveryEnabled() {
        return platformOn() && cfg.getBool("notify.enabled", cfg.getBool("phase1.delivery.enabled", false));
    }

    public long notifyPollMs() {
        long sec = Math.max(10, cfg.getLong("notify.poll_sec", 30));
        return sec * 1000L;
    }
}
