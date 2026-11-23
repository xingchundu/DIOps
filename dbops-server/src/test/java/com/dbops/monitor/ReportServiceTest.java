package com.dbops.monitor;

import org.junit.jupiter.api.Test;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 运行报告：时间段与摘要结论 */
class ReportServiceTest {

    @Test
    void periods() {
        LocalDate wed = LocalDate.parse("2026-11-11");
        LocalDateTime[] day = ReportService.period("DAY", wed, null, null);
        assertEquals(LocalDateTime.parse("2026-11-10T00:00"), day[0]);
        assertEquals(LocalDateTime.parse("2026-11-11T00:00"), day[1]);
        LocalDateTime[] week = ReportService.period("WEEK", wed, null, null);
        assertEquals(LocalDateTime.parse("2026-11-02T00:00"), week[0]);   // 上周一
        assertEquals(LocalDateTime.parse("2026-11-09T00:00"), week[1]);   // 本周一（不含）
        LocalDateTime[] month = ReportService.period("MONTH", wed, null, null);
        assertEquals(LocalDateTime.parse("2026-10-01T00:00"), month[0]);
        assertEquals(LocalDateTime.parse("2026-11-01T00:00"), month[1]);
        LocalDateTime[] c = ReportService.period("CUSTOM", wed, "2026-11-01", "2026-11-03");
        assertEquals(LocalDateTime.parse("2026-11-04T00:00"), c[1]);      // 含结束当天
    }

    @Test
    void findingsOrderAndContent() {
        Map<String, Object> av = Map.of("overall", 98.5, "rows", List.of(
                Map.of("INSTANCE_NAME", "crmdb", "OUTAGES", 2L, "DOWN_MINUTES", 30L),
                Map.of("INSTANCE_NAME", "pg", "OUTAGES", 0L, "DOWN_MINUTES", 0L)));
        List<Map<String, Object>> f = ReportService.findings(av, Map.of("TOTAL", 30L, "MTTR_MIN", 12.5), Map.of("TOTAL", 10L),
                List.of(Map.of("INSTANCE_NAME", "crmdb", "tsMax", 91.0)),
                Map.of("problemsByRule", List.of(Map.of("CNT", 3L)), "anomaliesByCause", List.of()),
                Map.of("backup", Map.of("TOTAL", 7L, "FAILED", 1L)));
        assertEquals("CRIT", f.get(0).get("level"));
        assertTrue(String.valueOf(f.get(0).get("text")).contains("crmdb（2 次，约 30 分钟）"));
        assertTrue(f.stream().anyMatch(x -> String.valueOf(x.get("text")).contains("较上一周期增加 200%")));
        assertTrue(f.stream().anyMatch(x -> String.valueOf(x.get("text")).contains("表空间 91%")));
        assertTrue(f.stream().anyMatch(x -> String.valueOf(x.get("text")).contains("备份失败 1 次")));
    }
}
