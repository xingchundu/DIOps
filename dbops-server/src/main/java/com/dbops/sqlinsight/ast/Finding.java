package com.dbops.sqlinsight.ast;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 规则命中结果。字段名 code / severity / message 与原审核接口保持一致，前端无需修改。
 */
public record Finding(String code, String severity, String title, String message, String suggestion) {

    public Map<String, Object> toMap() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("code", code);
        m.put("severity", severity);
        m.put("title", title);
        m.put("message", message);
        if (suggestion != null) {
            m.put("suggestion", suggestion);
        }
        return m;
    }

    /** 未执行的规则（依赖的元数据/指标不可用）：不能当作“通过” */
    public record Skipped(String code, String reason) {
        public Map<String, Object> toMap() {
            return Map.of("code", code, "reason", reason);
        }
    }
}
