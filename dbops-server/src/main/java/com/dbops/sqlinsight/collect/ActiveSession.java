package com.dbops.sqlinsight.collect;

/** 活动会话采样（P-001 / P-002 运行中慢 SQL、P-010 锁等待） */
public record ActiveSession(String sessionId, String nativeId, String schema, String sqlText, double runSec,
                            String waitEvent, double waitSec, boolean lockWait, String blockingSession) {
}
