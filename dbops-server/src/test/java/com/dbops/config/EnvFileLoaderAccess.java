package com.dbops.config;

/** 测试访问包内方法 */
public final class EnvFileLoaderAccess {
    private EnvFileLoaderAccess() {
    }

    public static int apply(java.util.List<String> lines) {
        return EnvFileLoader.apply(lines);
    }
}
