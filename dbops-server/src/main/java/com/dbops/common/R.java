package com.dbops.common;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 统一响应体，与 Node 版保持一致：HTTP 200 + {code, msg, data}。
 */
public final class R {

    private R() {
    }

    public static Map<String, Object> ok(Object data) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("code", 200);
        m.put("data", data);
        return m;
    }

    public static Map<String, Object> ok(Object data, String msg) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("code", 200);
        m.put("msg", msg);
        m.put("data", data);
        return m;
    }

    public static Map<String, Object> msg(String msg) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("code", 200);
        m.put("msg", msg);
        return m;
    }

    public static Map<String, Object> fail(int code, String msg) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("code", code);
        m.put("msg", msg);
        return m;
    }

    public static Map<String, Object> badRequest(String msg) {
        return fail(400, msg);
    }

    public static Map<String, Object> forbidden() {
        return fail(403, "权限不足");
    }

    public static Map<String, Object> notFound(String msg) {
        return fail(404, msg);
    }

    /** 便捷构造有序 Map：R.map("a", 1, "b", 2) */
    public static Map<String, Object> map(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i + 1 < kv.length; i += 2) {
            m.put(String.valueOf(kv[i]), kv[i + 1]);
        }
        return m;
    }
}
