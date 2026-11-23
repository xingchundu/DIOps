package com.dbops.service;

import com.dbops.common.Db;
import com.dbops.common.Values;
import com.dbops.security.CurrentUser;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * SYS_AUDIT_LOG 写入。审计失败只记日志，不影响主流程。
 */
@Service
public class AuditService {

    private static final Logger log = LoggerFactory.getLogger(AuditService.class);
    private final Db db;

    public AuditService(Db db) {
        this.db = db;
    }

    public void log(Long userId, String username, String action, String resource, String resourceId,
                    String ip, String status, String detail) {
        try {
            db.update("INSERT INTO SYS_AUDIT_LOG (USER_ID, USERNAME, ACTION, \"RESOURCE\", RESOURCE_ID, IP_ADDR, STATUS, DETAIL) "
                            + "VALUES (?,?,?,?,?,?,?,?)",
                    userId, Values.truncate(username, 64), Values.truncate(action, 128), Values.truncate(resource, 128),
                    Values.truncate(resourceId, 64), Values.truncate(ip, 64), status, detail);
        } catch (Exception e) {
            log.warn("[audit] write failed: {}", e.getMessage());
        }
    }

    public void log(CurrentUser u, String action, String resource, String resourceId, String status, String detail) {
        log(u == null ? null : u.userId(), u == null ? null : u.username(), action, resource, resourceId, null, status, detail);
    }
}
