package com.dbops.monitor;

import org.junit.jupiter.api.Test;

import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

/** 监控中心卡片的状态 / 等级判定 */
class MonitorBoardServiceTest {

    static Map<String, Object> inst(String status) {
        Map<String, Object> m = new HashMap<>();
        m.put("INSTANCE_ID", 1L);
        m.put("INSTANCE_NAME", "crmdb");
        m.put("STATUS", status);
        return m;
    }

    static Map<String, Object> sample(long ageMs, int reachable, Integer score, String detail, String err) {
        Map<String, Object> m = new HashMap<>();
        m.put("COLLECTED_AT", new Timestamp(System.currentTimeMillis() - ageMs));
        m.put("REACHABLE", reachable);
        m.put("HEALTH_SCORE", score);
        m.put("HEALTH_DETAIL", detail);
        m.put("ERR_MSG", err);
        return m;
    }

    static MonitorBoardService.Item item(Map<String, Object> i, Map<String, Object> s) {
        return MonitorBoardService.item(i, s, null, System.currentTimeMillis(), 90_000);
    }

    @Test
    void statusAndGrade() {
        assertEquals("NEVER", item(inst("UNKNOWN"), null).status());
        assertEquals("STOPPED", item(inst("STOPPED"), sample(1000, 1, 95, null, null)).status());

        MonitorBoardService.Item off = item(inst("ERROR"), sample(1000, 0, 0, null, "ORA-01017: invalid username/password; logon denied"));
        assertEquals("OFFLINE", off.status());
        assertEquals("OFFLINE", off.grade());
        assertNull(off.map().get("score"));   // 离线不显示 0 分
        assertEquals("用户名或密码错误", off.map().get("error"));

        String detail = HealthScorer.compute("ORACLE", new HealthScorer.Snapshot(new ArrayList<>(List.of()), null, null)).dimensions().toString();
        MonitorBoardService.Item ok = item(inst("RUNNING"), sample(30_000, 1, 92, "{\"version\":2,\"grade\":\"HEALTHY\",\"issues\":[],\"checked\":5}", null));
        assertEquals("ONLINE", ok.status());
        assertEquals("HEALTHY", ok.grade());
        assertEquals(92, ok.map().get("score"));

        // 超过 3 个采集周期（且 ≥10 分钟）没有新样本：数据过期，不给结论
        MonitorBoardService.Item stale = item(inst("RUNNING"), sample(20 * 60_000L, 1, 92, null, null));
        assertEquals("STALE", stale.status());
        assertEquals("UNKNOWN", stale.grade());

        // 旧版样本（没有 version）按分数给等级
        assertEquals("ATTENTION", item(inst("RUNNING"), sample(1000, 1, 70, "{\"performance\":{}}", null)).grade());
        assertEquals(detail.isEmpty(), false);
    }

    @Test
    void friendlyErrors() {
        assertEquals("连接超时（网络不通或防火墙）", MonitorBoardService.friendlyError("IO Error: The Network Adapter could not establish the connection: Connect timed out"));
        assertEquals("端口拒绝连接（数据库或监听未启动）", MonitorBoardService.friendlyError("Connection refused"));
        assertEquals("连接失败", MonitorBoardService.friendlyError(null));
    }

    @Test
    void sparkDownsamples() {
        List<Map<String, Object>> rows = new ArrayList<>();
        for (int i = 0; i < 100; i++) {
            Map<String, Object> r = new HashMap<>();
            r.put("COLLECTED_AT", new Timestamp(i));
            r.put("METRIC_CPU", (double) i);
            r.put("HEALTH_SCORE", 90);
            r.put("REACHABLE", 1);
            rows.add(r);
        }
        Map<String, Object> s = MonitorBoardService.spark(rows);
        assertEquals(20, ((List<?>) s.get("cpu")).size());   // 100 个点，步长 5
        assertEquals(99.0, ((List<?>) s.get("cpu")).get(19));   // 最后一个点是最新值
    }
}
