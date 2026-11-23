package com.dbops.alert;

import java.time.DayOfWeek;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.temporal.ChronoUnit;
import java.util.BitSet;

/**
 * 周期性静默窗口判断：标准 5 段 cron（分 时 日 月 周）+ 持续分钟数。
 * <p>
 * [fix] Node 版 isInRecurringWindow 的问题：
 * <ul>
 *   <li>周字段用 parseInt 解析，"1-5" 被当成 1（只有周一生效）；不支持 7=周日、步长、范围</li>
 *   <li>日、月字段被忽略</li>
 *   <li>跨零点窗口（如周五 23:00 持续 120 分钟）在周六 00:30 判断时用的是“周六”去匹配周字段，结果不命中</li>
 * </ul>
 * 这里的做法：向前回溯 duration 分钟，看其中是否存在某一分钟命中 cron —— 天然处理跨天、跨周。
 */
public final class CronWindow {

    private static final int MAX_DURATION_MIN = 7 * 24 * 60;

    private final BitSet minutes;
    private final BitSet hours;
    private final BitSet days;
    private final BitSet months;
    private final BitSet weekdays;
    private final boolean domRestricted;
    private final boolean dowRestricted;

    private CronWindow(String expr) {
        String[] p = expr.trim().split("\\s+");
        if (p.length < 5) {
            throw new IllegalArgumentException("cron 需要 5 段: " + expr);
        }
        minutes = parseField(p[0], 0, 59);
        hours = parseField(p[1], 0, 23);
        days = parseField(p[2], 1, 31);
        months = parseField(p[3], 1, 12);
        BitSet dow = parseField(p[4], 0, 7);
        if (dow.get(7)) {
            dow.set(0);
        }
        weekdays = dow;
        domRestricted = !p[2].equals("*") && !p[2].equals("?");
        dowRestricted = !p[4].equals("*") && !p[4].equals("?");
    }

    public static CronWindow parse(String expr) {
        return new CronWindow(expr);
    }

    /** 校验表达式，非法返回错误信息 */
    public static String validate(String expr) {
        try {
            parse(expr);
            return null;
        } catch (IllegalArgumentException e) {
            return e.getMessage();
        }
    }

    public boolean matches(ZonedDateTime t) {
        if (!minutes.get(t.getMinute()) || !hours.get(t.getHour()) || !months.get(t.getMonthValue())) {
            return false;
        }
        int dow = t.getDayOfWeek() == DayOfWeek.SUNDAY ? 0 : t.getDayOfWeek().getValue();
        boolean domOk = days.get(t.getDayOfMonth());
        boolean dowOk = weekdays.get(dow);
        // Vixie cron 语义：日、周都受限时任一满足即可
        if (domRestricted && dowRestricted) {
            return domOk || dowOk;
        }
        return domOk && dowOk;
    }

    public boolean inWindow(int durationMin, ZonedDateTime now) {
        if (durationMin <= 0) {
            return false;
        }
        int d = Math.min(durationMin, MAX_DURATION_MIN);
        ZonedDateTime t = now.truncatedTo(ChronoUnit.MINUTES);
        for (int k = 0; k < d; k++) {
            if (matches(t.minusMinutes(k))) {
                return true;
            }
        }
        return false;
    }

    public static boolean inWindow(String expr, int durationMin, String timezone, ZonedDateTime nowUtcOrAny) {
        try {
            ZoneId zone = ZoneId.of(timezone == null || timezone.isBlank() ? "Asia/Shanghai" : timezone.trim());
            return parse(expr).inWindow(durationMin, nowUtcOrAny.withZoneSameInstant(zone));
        } catch (Exception e) {
            return false;
        }
    }

    static BitSet parseField(String field, int min, int max) {
        BitSet bs = new BitSet(max + 1);
        for (String part : field.split(",")) {
            String p = part.trim();
            if (p.isEmpty()) {
                throw new IllegalArgumentException("cron 字段为空: " + field);
            }
            int step = 1;
            int slash = p.indexOf('/');
            if (slash >= 0) {
                step = Integer.parseInt(p.substring(slash + 1));
                if (step <= 0) {
                    throw new IllegalArgumentException("cron 步长非法: " + p);
                }
                p = p.substring(0, slash);
            }
            int lo;
            int hi;
            if (p.equals("*") || p.equals("?")) {
                lo = min;
                hi = max;
            } else if (p.contains("-")) {
                String[] ab = p.split("-");
                lo = Integer.parseInt(ab[0].trim());
                hi = Integer.parseInt(ab[1].trim());
            } else {
                lo = Integer.parseInt(p);
                hi = slash >= 0 ? max : lo;
            }
            if (lo < min || hi > max || lo > hi) {
                throw new IllegalArgumentException("cron 取值越界: " + part + "（允许 " + min + "-" + max + "）");
            }
            for (int v = lo; v <= hi; v += step) {
                bs.set(v);
            }
        }
        return bs;
    }
}
