package com.dbops.common;

import com.dbops.config.DbopsProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.multipart.MaxUploadSizeExceededException;

import java.util.Map;

/**
 * 与 Node 版一致：业务错误同样返回 HTTP 200，code 字段区分。
 * 非业务异常：开发环境回显 message（便于排查，Node 版各路由也是 res.json({code:500,msg:err.message})），生产环境隐藏。
 */
@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);
    private final boolean production;

    public GlobalExceptionHandler(DbopsProperties props) {
        this.production = props.getSecurity().isProductionMode();
    }

    @ExceptionHandler(BizException.class)
    public Map<String, Object> biz(BizException e) {
        return R.fail(e.getCode(), e.getMessage());
    }

    @ExceptionHandler({MethodArgumentTypeMismatchException.class, MissingServletRequestParameterException.class,
            HttpMessageNotReadableException.class, NumberFormatException.class})
    public Map<String, Object> badRequest(Exception e) {
        return R.badRequest("参数格式错误: " + e.getMessage());
    }

    @ExceptionHandler(MaxUploadSizeExceededException.class)
    public Map<String, Object> tooLarge(MaxUploadSizeExceededException e) {
        return R.badRequest("上传文件过大");
    }

    @ExceptionHandler(Exception.class)
    public Map<String, Object> other(Exception e) {
        // 平台库未执行迁移脚本：给出可操作的提示，而不是 ORA-00942 / 生产环境的“服务器内部错误”
        if (Db.isMissingTable(e) && String.valueOf(e.getMessage()).contains("DI_")) {
            log.warn("SQL 洞察数据表缺失: {}", e.getMessage());
            return R.fail(500, "SQL 洞察数据表未初始化：请在平台库执行 backend/sql/migration_sql_insight.sql 后重试");
        }
        if (Db.isMissingTable(e) || Db.isMissingColumn(e)) {
            log.warn("平台库表结构缺失: {}", e.getMessage());
            return R.fail(500, "平台库表结构不完整（" + firstLine(e.getMessage()) + "），请用平台库用户完整执行 sql/init.sql（离线包）或联系厂商获取升级脚本");
        }
        log.error("Unhandled error", e);
        String msg = e.getMessage();
        if (production || msg == null) {
            msg = "服务器内部错误";
        }
        return R.fail(500, msg);
    }

    private static String firstLine(String m) {
        if (m == null) {
            return "";
        }
        int i = m.indexOf("ORA-");
        String s = i >= 0 ? m.substring(i) : m;
        int nl = s.indexOf('\n');
        return Values.truncate(nl > 0 ? s.substring(0, nl) : s, 160);
    }
}
