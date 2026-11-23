package com.dbops.platform.notify;

import com.dbops.common.Values;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

/**
 * Webhook 外发（JDK HttpClient，无新增依赖）。
 * 修改者: dxc | 时间: 2026-11-12
 */
@Component
public class WebhookSender {

    private static final Logger log = LoggerFactory.getLogger(WebhookSender.class);
    private final HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(8)).build();

    public void send(String url, String secretHeader, String secretToken, String jsonBody) throws Exception {
        if (Values.isBlank(url)) {
            throw new IllegalArgumentException("ENDPOINT_URL 为空");
        }
        HttpRequest.Builder b = HttpRequest.newBuilder()
                .uri(URI.create(url.trim()))
                .timeout(Duration.ofSeconds(15))
                .header("Content-Type", "application/json; charset=utf-8")
                .POST(HttpRequest.BodyPublishers.ofString(jsonBody));
        if (!Values.isBlank(secretToken)) {
            String h = Values.isBlank(secretHeader) ? "X-Webhook-Token" : secretHeader.trim();
            b.header(h, secretToken.trim());
        }
        HttpResponse<String> resp = client.send(b.build(), HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() < 200 || resp.statusCode() >= 300) {
            throw new IllegalStateException("HTTP " + resp.statusCode() + ": " + Values.truncate(resp.body(), 300));
        }
        log.debug("[phase1-notify] webhook ok {}", resp.statusCode());
    }
}
