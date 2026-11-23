package com.dbops.sqlinsight.store;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.util.LinkedHashMap;
import java.util.Map;

/** 模块内 JSON 小工具 */
public final class Json {
    public static final ObjectMapper MAPPER = new ObjectMapper();

    private Json() {
    }

    public static String write(Object o) {
        try {
            return MAPPER.writeValueAsString(o);
        } catch (Exception e) {
            return "{}";
        }
    }

    public static Map<String, Object> map(String s) {
        if (s == null || s.isBlank()) {
            return new LinkedHashMap<>();
        }
        try {
            return MAPPER.readValue(s, new TypeReference<LinkedHashMap<String, Object>>() {
            });
        } catch (Exception e) {
            return new LinkedHashMap<>();
        }
    }

    public static Object any(String s) {
        if (s == null || s.isBlank()) {
            return null;
        }
        try {
            return MAPPER.readValue(s, Object.class);
        } catch (Exception e) {
            return s;
        }
    }
}
