package com.dbops.monitor;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 累计计数器 → 区间增量 / 速率。
 * <p>
 * [fix] Node 版直接把累计值当瞬时值使用：
 * <ul>
 *   <li>SQL Server "Batch Requests/sec" 的 cntr_value 是自启动以来的累计值，却被标成 "/s"</li>
 *   <li>MySQL Slow_queries 是累计值，健康评分按它打分 → 实例运行越久分越低，且永远回不来</li>
 * </ul>
 * 这里按 (实例, 计数器) 记录上一次采样，计算增量与每秒速率。计数器回绕/重启（新值 &lt; 旧值）时重新起算。
 */
public class CounterTracker {

    private record Sample(double value, long atMs, Double lastRate, Double lastDelta) {
    }

    private final Map<String, Sample> last = new ConcurrentHashMap<>();
    private final long minIntervalMs;

    public CounterTracker() {
        this(1000);
    }

    public CounterTracker(long minIntervalMs) {
        this.minIntervalMs = minIntervalMs;
    }

    public record Delta(Double delta, Double ratePerSec) {
    }

    /**
     * 记录新的累计值并返回与上一次相比的增量和速率；首次采样返回 (null, null)。
     */
    public Delta observe(long instanceId, String counter, Double value, long nowMs) {
        if (value == null) {
            return new Delta(null, null);
        }
        String key = instanceId + "|" + counter;
        Sample prev = last.get(key);
        if (prev == null || value < prev.value) {
            last.put(key, new Sample(value, nowMs, null, null));
            return new Delta(null, null);
        }
        long dt = nowMs - prev.atMs;
        if (dt < minIntervalMs) {
            // 两次调用间隔太短（例如页面刷新），沿用上次结果，不覆盖基准点
            return new Delta(prev.lastDelta, prev.lastRate);
        }
        double delta = value - prev.value;
        double rate = delta * 1000.0 / dt;
        last.put(key, new Sample(value, nowMs, rate, delta));
        return new Delta(delta, rate);
    }

    /** 用持久化的上一次样本做种子（服务重启后第一轮就能算出增量） */
    public void seedIfAbsent(long instanceId, String counter, Double value, long atMs) {
        if (value != null) {
            last.putIfAbsent(instanceId + "|" + counter, new Sample(value, atMs, null, null));
        }
    }

    public boolean hasSample(long instanceId, String counter) {
        return last.containsKey(instanceId + "|" + counter);
    }

    public void forget(long instanceId) {
        String prefix = instanceId + "|";
        last.keySet().removeIf(k -> k.startsWith(prefix));
    }
}
