package com.dbops.platform.governance;

import com.dbops.common.Db;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Map;

/**
 * 恢复演练待办查询（登记由 Node phase2 作业写入）。
 * 修改者: dxc | 时间: 2026-11-12
 */
@Service
public class RestoreDrillService {

    private final Db db;

    public RestoreDrillService(Db db) {
        this.db = db;
    }

    public List<Map<String, Object>> recent(int limit) {
        int n = Math.max(1, Math.min(limit, 200));
        try {
            return db.query("SELECT d.*, p.POLICY_NAME, i.INSTANCE_NAME FROM BACKUP_RESTORE_DRILL d "
                    + "LEFT JOIN BACKUP_POLICY_PRO p ON p.POLICY_ID = d.POLICY_ID "
                    + "LEFT JOIN CMDB_INSTANCE i ON i.INSTANCE_ID = d.INSTANCE_ID "
                    + "ORDER BY d.CREATED_AT DESC FETCH FIRST " + n + " ROWS ONLY");
        } catch (Exception e) {
            if (Db.isMissingTable(e)) {
                return List.of();
            }
            throw e;
        }
    }
}
