package com.dbops.alert;

import org.junit.jupiter.api.Test;

import java.time.ZoneId;
import java.time.ZonedDateTime;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class CronWindowTest {

    private static final ZoneId SH = ZoneId.of("Asia/Shanghai");

    private static ZonedDateTime at(int y, int mo, int d, int h, int mi) {
        return ZonedDateTime.of(y, mo, d, h, mi, 0, 0, SH);
    }

    @Test
    void weekdayRangeIsParsedAsRange() {
        // 2026-11-04 是周三；Node 版把 "1-5" 解析成 1，只有周一生效
        assertTrue(CronWindow.inWindow("0 2 * * 1-5", 60, "Asia/Shanghai", at(2026, 11, 4, 2, 30)));
        assertFalse(CronWindow.inWindow("0 2 * * 1-5", 60, "Asia/Shanghai", at(2026, 11, 7, 2, 30))); // 周六
        assertFalse(CronWindow.inWindow("0 2 * * 1-5", 60, "Asia/Shanghai", at(2026, 11, 4, 3, 0)));  // 窗口刚结束
    }

    @Test
    void windowAcrossMidnightUsesTriggerDay() {
        // 周五 23:00 起 120 分钟，周六 00:30 仍在窗口内
        assertTrue(CronWindow.inWindow("0 23 * * 5", 120, "Asia/Shanghai", at(2026, 11, 7, 0, 30)));
        assertFalse(CronWindow.inWindow("0 23 * * 5", 120, "Asia/Shanghai", at(2026, 11, 7, 1, 0)));
    }

    @Test
    void sundayAsSevenAndSteps() {
        assertTrue(CronWindow.inWindow("0 1 * * 7", 30, "Asia/Shanghai", at(2026, 11, 8, 1, 10))); // 周日
        assertTrue(CronWindow.inWindow("*/15 * * * *", 5, "Asia/Shanghai", at(2026, 11, 8, 9, 47)));
        assertFalse(CronWindow.inWindow("*/15 * * * *", 5, "Asia/Shanghai", at(2026, 11, 8, 9, 50)));
    }

    @Test
    void timezoneIsHonoured() {
        ZonedDateTime utc = ZonedDateTime.of(2026, 11, 4, 18, 30, 0, 0, ZoneId.of("UTC")); // = 上海 11-05 02:30
        assertTrue(CronWindow.inWindow("0 2 * * *", 60, "Asia/Shanghai", utc));
        assertFalse(CronWindow.inWindow("0 2 * * *", 60, "UTC", utc));
    }

    @Test
    void validation() {
        assertNull(CronWindow.validate("0 2 * * 1-5"));
        assertNotNull(CronWindow.validate("0 25 * * *"));
        assertNotNull(CronWindow.validate("0 2 * *"));
        assertNotNull(CronWindow.validate("x 2 * * *"));
    }
}
