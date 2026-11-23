package com.dbops.monitor;

import com.dbops.common.Db;
import com.dbops.common.Values;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;

/**
 * 启动时把旧格式（Base64）的被管库密码 / SSH 凭据改写为 AES-GCM 加密格式。只在配置了 DBOPS_SECRET_KEY 时执行；
 * 逐行“读出明文 → 加密 → 以旧值为条件更新”，并发修改过的行不会被覆盖。
 */
@Component
public class SecretsMigrator {

    private static final Logger log = LoggerFactory.getLogger(SecretsMigrator.class);
    private final Db db;

    public SecretsMigrator(Db db) {
        this.db = db;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void migrate() {
        if (!Secrets.keyConfigured()) {
            log.warn("[secrets] 未配置 DBOPS_SECRET_KEY：被管库密码与 SSH 凭据仍为 Base64 编码（不是加密）");
            return;
        }
        int n = 0;
        n += migrate("CMDB_INSTANCE", "INSTANCE_ID", "DB_PASSWORD");
        n += migrate("CMDB_HOST", "HOST_ID", "SSH_PASSWORD");
        n += migrate("CMDB_HOST", "HOST_ID", "SSH_PRIVATE_KEY");
        if (n > 0) {
            log.info("[secrets] 已将 {} 条凭据改写为 AES-GCM 加密格式", n);
        }
    }

    int migrate(String table, String idCol, String col) {
        int n = 0;
        try {
            List<Map<String, Object>> rows = db.query("SELECT " + idCol + " ID, " + col + " V FROM " + table + " WHERE " + col + " IS NOT NULL");
            for (Map<String, Object> r : rows) {
                Object v = r.get("V");
                if (!Secrets.isLegacy(v)) {
                    continue;
                }
                String plain = Secrets.decode(v);
                String enc = Secrets.encode(plain);
                if (enc == null) {
                    continue;
                }
                boolean clob = col.equals("SSH_PRIVATE_KEY");
                n += clob
                        ? db.update("UPDATE " + table + " SET " + col + " = ? WHERE " + idCol + " = ? AND DBMS_LOB.COMPARE(" + col + ", TO_CLOB(?)) = 0",
                        enc, r.get("ID"), Values.str(v))
                        : db.update("UPDATE " + table + " SET " + col + " = ? WHERE " + idCol + " = ? AND " + col + " = ?", enc, r.get("ID"), Values.str(v));
            }
        } catch (Exception e) {
            log.warn("[secrets] 迁移 {}.{} 失败: {}", table, col, e.getMessage());
        }
        return n;
    }
}
