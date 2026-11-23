package com.dbops.monitor;

import com.dbops.common.R;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * SSH 命令输出解析（纯函数，便于单测）。对应 Node monitorHostCollect.js 中的 parseXxx。
 */
public final class HostParsers {

    private HostParsers() {
    }

    private static final Pattern IDLE = Pattern.compile("([0-9.]+)\\s*%?\\s*id\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern US = Pattern.compile("([0-9.]+)\\s*%?\\s*us\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern SY = Pattern.compile("([0-9.]+)\\s*%?\\s*sy\\b", Pattern.CASE_INSENSITIVE);

    /** top -bn1 的 Cpu(s) 行 → 使用率百分比 */
    public static Double parseCpuPct(String line) {
        if (line == null) {
            return null;
        }
        Matcher m = IDLE.matcher(line);
        if (m.find()) {
            return clampPct(100 - Double.parseDouble(m.group(1)));
        }
        Matcher u = US.matcher(line);
        if (u.find()) {
            double v = Double.parseDouble(u.group(1));
            Matcher s = SY.matcher(line);
            if (s.find()) {
                v += Double.parseDouble(s.group(1));
            }
            return clampPct(v);
        }
        return null;
    }

    /** vmstat 1 2 | tail -1 → 使用率（第 15 列 id）；列数不足返回 null */
    public static Double parseVmstatCpu(String line) {
        if (line == null) {
            return null;
        }
        String[] p = line.trim().split("\\s+");
        // procs(r b) memory(swpd free buff cache) swap(si so) io(bi bo) system(in cs) cpu(us sy id wa st)
        if (p.length < 15) {
            return null;
        }
        try {
            return clampPct(100 - Double.parseDouble(p[14]));
        } catch (NumberFormatException e) {
            return null;
        }
    }

    public record DfResult(List<Map<String, Object>> rows, Double maxPct) {
    }

    /** "device pct mount" 每行一条 */
    public static DfResult parseDf(String text) {
        List<Map<String, Object>> rows = new ArrayList<>();
        Double max = null;
        if (text != null) {
            for (String line : text.split("\n")) {
                String[] p = line.trim().split("\\s+");
                if (p.length < 3) {
                    continue;
                }
                String mount = p[2];
                double pct;
                try {
                    pct = Double.parseDouble(p[1]);
                } catch (NumberFormatException e) {
                    continue;
                }
                if (mount.equals("/dev") || mount.startsWith("/sys") || mount.startsWith("/run/user")
                        || mount.startsWith("/dev/shm") || mount.startsWith("/run") || p[0].equals("tmpfs")
                        || p[0].equals("devtmpfs") || p[0].equals("overlay") || mount.startsWith("/snap/")) {
                    continue;
                }
                rows.add(R.map("mount", mount, "usedPct", pct, "device", p[0]));
                max = max == null ? pct : Math.max(max, pct);
            }
        }
        return new DfResult(rows, max);
    }

    /** free -m 的 Mem 行 "total used free" → 使用率 */
    public static Double parseMemPct(String text) {
        if (text == null) {
            return null;
        }
        String[] p = text.trim().split("\\s+");
        if (p.length < 2) {
            return null;
        }
        try {
            double total = Double.parseDouble(p[0]);
            double used = Double.parseDouble(p[1]);
            return total > 0 ? Math.min(100, Metrics.round2(used / total * 100)) : null;
        } catch (NumberFormatException e) {
            return null;
        }
    }

    public static Double parseLoad1(String text) {
        if (text == null || text.isBlank()) {
            return null;
        }
        String first = text.trim().split("\\s+")[0];
        try {
            return Double.parseDouble(first);
        } catch (NumberFormatException e) {
            // uptime 输出：... load average: 0.12, 0.08, 0.05
            Matcher m = Pattern.compile("load averages?:\\s*([0-9.]+)").matcher(text);
            return m.find() ? Double.parseDouble(m.group(1)) : null;
        }
    }

    /** lsnrctl status → 1 就绪 / 0 异常 / null 未安装 */
    public static Integer parseListenerReady(String text) {
        String t = text == null ? "" : text;
        if (t.contains("__LSNR_MISSING__")) {
            return null;
        }
        boolean ok = Pattern.compile("STATUS of the LISTENER|Listener LOG", Pattern.CASE_INSENSITIVE).matcher(t).find()
                && !Pattern.compile("TNS-12541|TNS-12560|does not exist", Pattern.CASE_INSENSITIVE).matcher(t).find();
        return ok ? 1 : 0;
    }

    /**
     * crsctl stat res -t → “目标 ONLINE 但实际不是 ONLINE”的资源实例数。
     * <p>
     * [fix] Node 版逐行判断“同一行包含 OFFLINE 且包含 ora.xxx”，但 -t 格式资源名和状态在不同行，导致始终为 0，
     * 然后回退成“全文 OFFLINE 出现次数”，把目标就是 OFFLINE 的资源（如 ora.gsd、备用 VIP）也算成故障。
     * 格式示例：
     * <pre>
     * ora.orcl.db
     *       1        ONLINE  ONLINE       node1                    Open,STABLE
     *       2        ONLINE  OFFLINE                               STABLE
     * ora.LISTENER.lsnr
     *                ONLINE  ONLINE       node1                    STABLE
     * </pre>
     */
    public static Integer parseCrsOffline(String text) {
        String t = text == null ? "" : text;
        if (t.contains("__CRS_MISSING__")) {
            return null;
        }
        Pattern stateLine = Pattern.compile("^\\s+(?:\\d+\\s+)?(ONLINE|OFFLINE)\\s+(ONLINE|OFFLINE|INTERMEDIATE|UNKNOWN)\\b",
                Pattern.CASE_INSENSITIVE);
        int bad = 0;
        for (String line : t.split("\n")) {
            Matcher m = stateLine.matcher(line);
            if (m.find()) {
                String target = m.group(1).toUpperCase();
                String state = m.group(2).toUpperCase();
                if (target.equals("ONLINE") && !state.equals("ONLINE")) {
                    bad++;
                }
            }
        }
        return bad;
    }

    /**
     * gs_om -t status --detail → 1 集群异常 / 0 正常 / null 未安装。
     * [fix] Node 版用 /Normal/ 全文匹配，cluster_state 为 Degraded 但任一实例行出现 Normal 时被判为正常。
     */
    public static Integer parseGsOmAbnormal(String text) {
        String t = text == null ? "" : text;
        if (t.contains("__GS_OM_MISSING__")) {
            return null;
        }
        Matcher m = Pattern.compile("cluster[_ ]state\\s*:\\s*(\\w+)", Pattern.CASE_INSENSITIVE).matcher(t);
        if (m.find()) {
            return "Normal".equalsIgnoreCase(m.group(1)) ? 0 : 1;
        }
        // 输出格式未知：出现明显异常关键字才判异常
        return Pattern.compile("Degraded|Abnormal|Unavailable|Down\\b", Pattern.CASE_INSENSITIVE).matcher(t).find() ? 1 : 0;
    }

    private static double clampPct(double v) {
        return Math.max(0, Math.min(100, Metrics.round2(v)));
    }
}
