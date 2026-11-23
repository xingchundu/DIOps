package com.dbops.service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** 非管理员读取系统配置时脱敏 */
public final class SystemConfigMask {

    private static final String MASK = "********";

    private SystemConfigMask() {
    }

    public static boolean isSensitiveKey(String key) {
        if (key == null || key.isBlank()) {
            return false;
        }
        String k = key.toLowerCase(Locale.ROOT);
        return k.contains("secret") || k.contains("password") || k.contains("token")
                || k.contains("credential") || (k.contains("api") && k.contains("key"));
    }

    public static List<Map<String, Object>> maskForReader(List<Map<String, Object>> rows, boolean privileged) {
        if (privileged || rows == null) {
            return rows;
        }
        List<Map<String, Object>> out = new ArrayList<>(rows.size());
        for (Map<String, Object> row : rows) {
            Map<String, Object> copy = new LinkedHashMap<>(row);
            String key = String.valueOf(row.getOrDefault("CONFIG_KEY", ""));
            if (isSensitiveKey(key)) {
                copy.put("CONFIG_VALUE", MASK);
                copy.put("DEFAULT_VALUE", MASK);
            }
            out.add(copy);
        }
        return out;
    }
}
