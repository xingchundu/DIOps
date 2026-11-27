package com.dbops.monitor;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

class HostParsersTest {

    @Test
    void crsCountsOnlyTargetOnlineButNotOnline() {
        String out = String.join("\n",
                "--------------------------------------------------------------------------------",
                "Name           Target  State        Server                   State details",
                "--------------------------------------------------------------------------------",
                "Cluster Resources",
                "ora.orcl.db",
                "      1        ONLINE  ONLINE       node1                    Open,STABLE",
                "      2        ONLINE  OFFLINE                               STABLE",
                "ora.gsd",
                "      1        OFFLINE OFFLINE                               STABLE",
                "ora.LISTENER.lsnr",
                "               ONLINE  INTERMEDIATE node2                    STABLE");
        // Node 版：逐行匹配不到资源名 → 回退为全文 OFFLINE 计数 = 3（把目标就是 OFFLINE 的 ora.gsd 也算进去）
        assertEquals(2, HostParsers.parseCrsOffline(out));
        assertNull(HostParsers.parseCrsOffline("__CRS_MISSING__"));
    }

    @Test
    void gsOmUsesClusterState() {
        String degraded = "cluster_state   : Degraded\nredistributing  : No\n node1 6001 P Primary Normal\n";
        // Node 版因为实例行出现 Normal 判为正常
        assertEquals(1, HostParsers.parseGsOmAbnormal(degraded));
        assertEquals(0, HostParsers.parseGsOmAbnormal("cluster_state   : Normal\n"));
        assertNull(HostParsers.parseGsOmAbnormal("__GS_OM_MISSING__"));
    }

    @Test
    void cpuMemDfLoad() {
        assertEquals(5.3, HostParsers.parseCpuPct("%Cpu(s):  3.1 us,  2.2 sy,  0.0 ni, 94.7 id,  0.0 wa"));
        assertEquals(57.2, HostParsers.parseCpuSample("57.20\n"));
        assertEquals(2.0, HostParsers.parseCpuSample(String.join("\n",
                "%Cpu(s): 10.0 us, 40.0 sy, 0.0 ni, 50.0 id, 0.0 wa",
                "%Cpu(s): 1.0 us, 1.0 sy, 0.0 ni, 98.0 id, 0.0 wa")));
        assertEquals(12.0, HostParsers.parseVmstatCpu(" 1  0      0 812345  1234 456789    0    0     1     2   10   20  8  4 88  0  0"));
        assertEquals(50.0, HostParsers.parseMemPct("16000 8000 8000"));
        assertEquals(0.12, HostParsers.parseLoad1("0.12 0.08 0.05 1/234 5678"));
        HostParsers.DfResult df = HostParsers.parseDf("/dev/sda1 40 /\ntmpfs 100 /dev/shm\n/dev/sdb1 91 /u01\n");
        assertEquals(2, df.rows().size());
        assertEquals(91.0, df.maxPct());
        // loop 光盘镜像恒为 100%，不能当成数据盘把最大使用率打满
        HostParsers.DfResult real = HostParsers.parseDf(String.join("\n",
                "/dev/mapper/ol-root 54 /",
                "devtmpfs 1 /dev",
                "tmpfs 2 /run",
                "/dev/loop0 100 /dvd",
                "/dev/mapper/ol-oracle 73 /oracle",
                "/dev/mapper/vg_monitor-lv_monitor 84 /db_monitor"));
        assertEquals(3, real.rows().size());
        assertEquals(84.0, real.maxPct());
    }
}
