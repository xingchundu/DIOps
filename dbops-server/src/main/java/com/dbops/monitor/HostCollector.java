package com.dbops.monitor;

import com.dbops.common.Db;
import com.dbops.common.R;
import com.dbops.common.Values;
import com.dbops.config.DbopsProperties;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 阶段3 HOST 通道：SSH 白名单命令采集主机指标（对应 Node monitorHostCollect.js）。
 * <p>
 * 相对 Node 版的修正：
 * <ul>
 *   <li>[fix] 主机上 SSH_ENABLED=0 被忽略（只要有凭据仍会 SSH 登录）：现在明确关闭即跳过</li>
 *   <li>[改进] 通用主机指标（CPU/内存/负载/文件系统）对所有库类型采集，原来只有 Oracle/磐维</li>
 *   <li>[改进] 一轮采集复用一个 SSH 会话</li>
 * </ul>
 */
@Component
public class HostCollector {

    static final Map<String, String> CMD = new LinkedHashMap<>();

    static {
        CMD.put("loadavg", "cat /proc/loadavg 2>/dev/null || uptime");
        CMD.put("mem", "free -m 2>/dev/null | awk '/^Mem:/ {print $2,$3,$4}'");
        CMD.put("df", "LANG=C df -P 2>/dev/null | awk 'NR>1 {gsub(/%/,\"\",$5); print $1,$5,$6}'");
        // top -bn1 的第一帧是开机至今的平均，不是当前使用率。先采 1 秒 /proc/stat 差值；没有 /proc/stat 时再取 top 第二帧。
        CMD.put("cpu", "LANG=C awk 'function snap(   line,n,id,i){n=0;id=0;while((getline line < \"/proc/stat\")>0){if(line ~ /^cpu /){split(line,f);id=f[5]+0;for(i=2;i<=9;i++)n+=f[i];break}}close(\"/proc/stat\");return n\" \"id}BEGIN{split(snap(),a,\" \");if(a[1]+0<=0)exit 1;system(\"sleep 1\");split(snap(),b,\" \");dt=b[1]-a[1];if(dt<=0)exit 1;printf \"%.2f\\n\",(dt-(b[2]-a[2]))*100/dt}'"
                + " || LANG=C top -bn2 -d 1 2>/dev/null | grep -E 'Cpu\\(s\\)|%Cpu' | tail -1");
        CMD.put("vmstat", "vmstat 1 2 2>/dev/null | tail -1");
        CMD.put("listener", "bash -lc 'command -v lsnrctl >/dev/null 2>&1 && lsnrctl status 2>&1 | head -30 || echo __LSNR_MISSING__'");
        CMD.put("crs", "bash -lc 'command -v crsctl >/dev/null 2>&1 && crsctl stat res -t 2>&1 | head -200 || echo __CRS_MISSING__'");
        CMD.put("ora_ps", "ps -eo comm 2>/dev/null | grep -E '^ora_' | sort -u");
        CMD.put("gs_om", "bash -lc 'command -v gs_om >/dev/null 2>&1 && gs_om -t status --detail 2>&1 | head -120 || echo __GS_OM_MISSING__'");
        CMD.put("gs_ctl", "bash -lc 'command -v gs_ctl >/dev/null 2>&1 && gs_ctl query 2>&1 | head -40 || echo __GS_CTL_MISSING__'");
    }

    public record Result(List<Map<String, Object>> hostMetrics, Map<String, Object> hostSummary) {
    }

    private final Db db;
    private final DbopsProperties.Monitor cfg;

    public HostCollector(Db db, DbopsProperties props) {
        this.db = db;
        this.cfg = props.getMonitor();
    }

    public Result collect(long instanceId, String dbType) {
        Map<String, Object> row;
        try {
            row = db.one("SELECT i.INSTANCE_ID, i.DB_TYPE, i.HOST_ID, h.IP_ADDR, h.SSH_ENABLED, h.SSH_PORT, h.SSH_USER, "
                    + "h.SSH_PASSWORD, h.SSH_PRIVATE_KEY, h.SSH_AUTH_TYPE FROM CMDB_INSTANCE i "
                    + "LEFT JOIN CMDB_HOST h ON h.HOST_ID = i.HOST_ID WHERE i.INSTANCE_ID = ?", instanceId);
        } catch (Exception e) {
            if (Db.isMissingColumn(e)) {
                return skip("ssh_schema_missing", "CMDB_HOST 缺少 SSH 字段，请执行 migration_monitor_catalog_phase3.sql", null);
            }
            throw e;
        }
        Object hostId = row == null ? null : row.get("HOST_ID");
        if (hostId == null) {
            return new Result(List.of(Metrics.internal("_host_skip", "reason:no_host_id", null)), R.map("skip", "no_host_id"));
        }
        String ip = Values.str(row.get("IP_ADDR"));
        if (ip == null) {
            return new Result(List.of(Metrics.internal("_host_skip", "reason:host_row_missing", null)),
                    R.map("skip", "ssh_not_configured", "detail", "host_record_not_found", "hostId", hostId));
        }
        String user = Values.str(row.get("SSH_USER"));
        String pwd = Secrets.decode(row.get("SSH_PASSWORD"));
        String key = Secrets.decode(row.get("SSH_PRIVATE_KEY"));
        Object enabledRaw = row.get("SSH_ENABLED");
        boolean explicitlyDisabled = enabledRaw != null && !Values.isBlank(enabledRaw) && !Values.truthy(enabledRaw);
        String detail = null;
        if (user == null) {
            detail = "ssh_user_missing";
        } else if (pwd.isEmpty() && key.isEmpty()) {
            detail = "ssh_credentials_missing";
        } else if (explicitlyDisabled) {
            detail = "ssh_disabled_on_host";
        }
        if (detail != null) {
            Map<String, Object> sum = R.map("skip", "ssh_not_configured", "detail", detail, "hostId", hostId,
                    "sshEnabled", enabledRaw, "hasSshUser", user != null, "hasSshPassword", !pwd.isEmpty(),
                    "hasSshPrivateKey", !key.isEmpty());
            return new Result(List.of(Metrics.internal("_host_skip", "reason:" + detail, null)), sum);
        }
        int port = Values.toInt(row.get("SSH_PORT"), 22);
        if (port <= 0) {
            port = 22;
        }
        String dt = DbType.normalize(dbType != null ? dbType : row.get("DB_TYPE"));
        List<Map<String, Object>> metrics = new ArrayList<>();
        Map<String, Object> checks = new LinkedHashMap<>();
        Map<String, Object> summary = R.map("hostId", hostId, "ip", ip, "checks", checks);
        int cmdTimeout = Math.max(8000, cfg.getSshCmdMs());

        try (SshSession ssh = SshSession.connect(ip, port, user, pwd.isEmpty() ? null : pwd, key.isEmpty() ? null : key,
                Math.max(5000, cfg.getSshConnectMs()), cfg.isSshStrictHostKey(), cfg.getSshKnownHosts())) {
            SshSession.Result load = run(ssh, "loadavg", cmdTimeout);
            checks.put("loadavg", load.stdout().trim());
            Metrics.push(metrics, "host_load_1m", HostParsers.parseLoad1(load.stdout()), "");

            Metrics.push(metrics, "host_mem_used_pct", HostParsers.parseMemPct(run(ssh, "mem", cmdTimeout).stdout()), "%");

            SshSession.Result cpu = run(ssh, "cpu", cmdTimeout);
            Double cpuPct = HostParsers.parseCpuSample(cpu.stdout());
            if (cpuPct == null) {
                cpuPct = HostParsers.parseVmstatCpu(run(ssh, "vmstat", cmdTimeout).stdout());
            }
            if (cpuPct != null) {
                Metrics.push(metrics, "host_cpu_used_pct", cpuPct, "%");
                Metrics.push(metrics, "host_cpu_usage", cpuPct, "%");
            }

            HostParsers.DfResult df = HostParsers.parseDf(run(ssh, "df", cmdTimeout).stdout());
            summary.put("filesystems", df.rows());
            Metrics.push(metrics, "host_fs_used_pct_max", df.maxPct(), "%");
            Metrics.push(metrics, "host_ssh_ok", 1, "");

            if (DbType.ORACLE.equals(dt)) {
                SshSession.Result l = run(ssh, "listener", cmdTimeout);
                Integer ready = HostParsers.parseListenerReady(l.stdout() + l.stderr());
                summary.put("listener", R.map("ready", ready, "skipped", ready == null,
                        "excerpt", Values.truncate(l.stdout() + l.stderr(), 800)));
                Metrics.push(metrics, "host_listener_ready", ready, "");

                SshSession.Result crs = run(ssh, "crs", cmdTimeout);
                Integer off = HostParsers.parseCrsOffline(crs.stdout() + crs.stderr());
                summary.put("crs", R.map("offline", off, "skipped", off == null,
                        "excerpt", Values.truncate(crs.stdout() + crs.stderr(), 1200)));
                Metrics.push(metrics, "host_crs_resource_offline", off, "");

                SshSession.Result ps = run(ssh, "ora_ps", cmdTimeout);
                long n = ps.stdout().lines().filter(s -> !s.isBlank()).count();
                Metrics.push(metrics, "host_ora_background_proc_count", n, "");
            }
            if (DbType.PANWEI.equals(dt)) {
                if (isMetricHub(instanceId)) {
                    SshSession.Result gs = run(ssh, "gs_om", cmdTimeout);
                    Integer ab = HostParsers.parseGsOmAbnormal(gs.stdout() + gs.stderr());
                    summary.put("gsOm", R.map("abnormal", ab, "skipped", ab == null,
                            "excerpt", Values.truncate(gs.stdout() + gs.stderr(), 1500)));
                    Metrics.push(metrics, "panwei_gs_om_cluster_abnormal", ab, "");
                } else {
                    summary.put("gsOm", R.map("skipped", true, "reason", "not_metric_hub"));
                }
                SshSession.Result g = run(ssh, "gs_ctl", cmdTimeout);
                if (!g.stdout().contains("__GS_CTL_MISSING__")) {
                    summary.put("gsCtlExcerpt", Values.truncate(g.stdout(), 600));
                }
            }
        } catch (Exception e) {
            String msg = String.valueOf(e.getMessage());
            List<Map<String, Object>> err = new ArrayList<>();
            Metrics.push(err, "host_ssh_ok", 0, "");
            err.add(Metrics.internal("_host_error", Values.truncate(msg, 120), null));
            summary.put("error", msg);
            return new Result(err, summary);
        }
        return new Result(metrics, summary);
    }

    private static SshSession.Result run(SshSession ssh, String key, int timeoutMs) {
        try {
            return ssh.exec(CMD.get(key), timeoutMs);
        } catch (Exception e) {
            return new SshSession.Result(-1, "", String.valueOf(e.getMessage()));
        }
    }

    /** 磐维集群：若集群内配置了 METRIC_HUB 节点，只有它执行 gs_om（避免每个节点重复执行集群级命令） */
    private boolean isMetricHub(long instanceId) {
        List<Map<String, Object>> member = db.query("SELECT NODE_ROLE FROM CMDB_CLUSTER_MEMBER WHERE INSTANCE_ID = ?", instanceId);
        if (member.isEmpty()) {
            return true;
        }
        long hubs = db.count("SELECT COUNT(*) FROM CMDB_CLUSTER_MEMBER m JOIN CMDB_CLUSTER_MEMBER me "
                + "ON me.CLUSTER_ID = m.CLUSTER_ID AND me.INSTANCE_ID = ? WHERE UPPER(NVL(m.NODE_ROLE, ' ')) = 'METRIC_HUB'", instanceId);
        if (hubs == 0) {
            return true;
        }
        return "METRIC_HUB".equalsIgnoreCase(Values.str(member.get(0).get("NODE_ROLE"), ""));
    }

    private static Result skip(String reason, String detail, Object hostId) {
        return new Result(List.of(Metrics.internal("_host_skip", "reason:" + reason, detail)),
                R.map("skip", reason, "detail", detail, "hostId", hostId));
    }
}
