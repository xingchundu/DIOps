package com.dbops.controller;

import com.dbops.common.Db;
import com.dbops.common.R;
import com.dbops.common.Values;
import com.dbops.security.CurrentUser;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * SQL 评审工单「保存指派」的 Java 网关侧实现。
 *
 * <p>现场故障：点击「保存指派」返回「接口不存在: PATCH /api/sql-review/tickets/21/assign」。
 * 该路径只存在于 Node（backend/src/routes/sqlReview.js），部署时若 Java 网关版本较旧、
 * legacy 转发被关闭、或 Node 未重启加载新路由，请求就会落进兜底 404。
 * 这里在 Java 侧直接实现同路径、同语义的接口（PATCH / POST / PUT 均支持），
 * 与 Node 版写同一张表、同一套权限规则，任何一层命中都能正常工作。
 */
@RestController
public class SqlReviewAssignController {

    private static final List<String> OPEN_STATUSES = List.of("PENDING", "IN_REVIEW", "CHANGES_REQUESTED");
    private static final List<String> REVIEWER_ROLES = List.of("ADMIN", "DBA", "REVIEWER");

    private final Db db;

    public SqlReviewAssignController(Db db) {
        this.db = db;
    }

    @RequestMapping(value = "/api/sql-review/tickets/{id}/assign",
            method = {RequestMethod.PATCH, RequestMethod.POST, RequestMethod.PUT})
    public Map<String, Object> assign(CurrentUser u, @PathVariable("id") long id,
                                      @RequestBody(required = false) Map<String, Object> b) {
        Object raw = Values.get(b, "assignedTo");
        Long assignee;
        if (Values.isBlank(raw)) {
            assignee = null;                 // 允许空指派 → DBA 待审池
        } else {
            assignee = Values.toStrictLong(raw);
            if (assignee == null || assignee <= 0) {
                return R.badRequest("assignedTo 必须为正整数或空");
            }
        }

        Map<String, Object> ticket = db.one(
                "SELECT TICKET_ID, STATUS, SUBMITTED_BY, ASSIGNED_TO, TITLE FROM SQL_REVIEW_TICKET WHERE TICKET_ID=?", id);
        if (ticket == null) {
            return R.notFound("工单不存在");
        }
        String status = Values.str(ticket.get("STATUS"), "");
        if (!OPEN_STATUSES.contains(status)) {
            return R.fail(403, "当前状态或角色不允许改派");
        }
        long uid = u.userId();
        boolean submittedByMe = Values.numEq(ticket.get("SUBMITTED_BY"), uid);
        boolean assignedToMe = Values.numEq(ticket.get("ASSIGNED_TO"), uid);
        boolean unassigned = ticket.get("ASSIGNED_TO") == null;
        boolean visible = u.isAdmin() || submittedByMe || assignedToMe
                || (unassigned && u.hasRole("ADMIN", "DBA"));
        if (!visible) {
            return R.forbidden();
        }
        boolean canAssign = u.isAdmin() || submittedByMe || assignedToMe
                || (unassigned && u.hasRole("DBA"));
        if (!canAssign) {
            return R.fail(403, "当前状态或角色不允许改派");
        }

        String label = "未指派（DBA 待审池）";
        if (assignee != null) {
            Map<String, Object> user = db.one(
                    "SELECT USER_ID, USERNAME, REAL_NAME, ROLE FROM SYS_USER WHERE USER_ID=? AND STATUS=1", assignee);
            if (user == null) {
                return R.badRequest("指定审核人不存在或已禁用");
            }
            if (!REVIEWER_ROLES.contains(Values.str(user.get("ROLE"), ""))) {
                return R.badRequest("审核人须为 ADMIN / DBA / REVIEWER");
            }
            String realName = Values.str(user.get("REAL_NAME"));
            String userName = Values.str(user.get("USERNAME"), String.valueOf(assignee));
            label = (realName == null ? userName : realName) + "（" + userName + "）";
        }

        db.update("UPDATE SQL_REVIEW_TICKET SET ASSIGNED_TO=?, UPDATED_AT=SYSTIMESTAMP WHERE TICKET_ID=?", assignee, id);
        String comment = Values.get(b, "comment") == null ? "" : "；" + Values.str(Values.get(b, "comment"));
        db.update("INSERT INTO SQL_REVIEW_COMMENT (TICKET_ID, USER_ID, COMMENT_TEXT, COMMENT_TYPE) VALUES (?,?,?,'SYSTEM')",
                id, uid, Values.truncate("审核人已更新为：" + label + comment, 2000));
        return R.ok(R.map("assignedTo", assignee), "审核人已更新");
    }
}
