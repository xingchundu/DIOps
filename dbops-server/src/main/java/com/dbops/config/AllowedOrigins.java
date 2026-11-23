package com.dbops.config;

import org.springframework.stereotype.Component;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.Collections;
import java.util.Enumeration;
import java.util.LinkedHashSet;
import java.util.Set;

/**
 * 允许的前端来源（同 Node security.js buildAllowedOrigins）：本机所有 IPv4 × http/https × 常用端口 + FRONTEND_URL。
 */
@Component
public class AllowedOrigins {

    private static final int[] PORTS = {5173, 4173, 80, 443, 18443};
    private final Set<String> origins;

    public AllowedOrigins(DbopsProperties props) {
        Set<String> set = new LinkedHashSet<>();
        String fe = props.getSecurity().getFrontendUrl();
        if (fe != null) {
            for (String item : fe.split(",")) {
                String v = item.trim();
                if (!v.isEmpty()) {
                    set.add(v.replaceAll("/+$", ""));
                }
            }
        }
        for (String host : localHosts()) {
            for (String scheme : new String[]{"https", "http"}) {
                set.add(scheme + "://" + host);
                for (int p : PORTS) {
                    set.add(scheme + "://" + host + ":" + p);
                }
            }
        }
        this.origins = Collections.unmodifiableSet(set);
    }

    public Set<String> asSet() {
        return origins;
    }

    public boolean allows(String origin) {
        return origin != null && origins.contains(origin);
    }

    public boolean allowsReferer(String referer) {
        if (referer == null) {
            return false;
        }
        for (String o : origins) {
            if (referer.equals(o) || referer.startsWith(o + "/")) {
                return true;
            }
        }
        return false;
    }

    private static Set<String> localHosts() {
        Set<String> hosts = new LinkedHashSet<>();
        hosts.add("localhost");
        hosts.add("127.0.0.1");
        try {
            Enumeration<NetworkInterface> nis = NetworkInterface.getNetworkInterfaces();
            while (nis != null && nis.hasMoreElements()) {
                NetworkInterface ni = nis.nextElement();
                Enumeration<InetAddress> addrs = ni.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    InetAddress a = addrs.nextElement();
                    if (a instanceof Inet4Address) {
                        hosts.add(a.getHostAddress());
                    }
                }
            }
        } catch (Exception ignore) {
            // 取不到网卡信息时只保留 localhost
        }
        return hosts;
    }
}
