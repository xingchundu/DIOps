package com.dbops.platform.notify;

/**
 * 告警严重级别排序（外发渠道 MIN_SEVERITY 过滤）。
 * 修改者: dxc | 时间: 2026-11-12
 */
public final class NotifySeverityRank {

    private NotifySeverityRank() {
    }

    public static int rank(String sev) {
        if (sev == null) {
            return 99;
        }
        return switch (sev.toUpperCase()) {
            case "P1", "CRITICAL" -> 1;
            case "P2", "WARNING" -> 2;
            case "P3", "INFO" -> 3;
            default -> 4;
        };
    }

    public static boolean matches(String alertSev, String channelMin) {
        return rank(alertSev) <= rank(channelMin == null ? "P2" : channelMin);
    }
}
