package com.dbops.common;

/**
 * 业务异常：被 {@link GlobalExceptionHandler} 转成 {code, msg}。
 */
public class BizException extends RuntimeException {

    private final int code;

    public BizException(int code, String msg) {
        super(msg);
        this.code = code;
    }

    public int getCode() {
        return code;
    }

    public static BizException badRequest(String msg) {
        return new BizException(400, msg);
    }

    public static BizException notFound(String msg) {
        return new BizException(404, msg);
    }

    public static BizException forbidden() {
        return new BizException(403, "权限不足");
    }
}
