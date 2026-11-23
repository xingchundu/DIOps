package com.dbops.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * application.yml 中 dbops.* 配置。
 */
@ConfigurationProperties(prefix = "dbops")
public class DbopsProperties {

    private Datasource datasource = new Datasource();
    private Security security = new Security();
    private Monitor monitor = new Monitor();
    private Legacy legacy = new Legacy();

    public Datasource getDatasource() { return datasource; }
    public void setDatasource(Datasource datasource) { this.datasource = datasource; }
    public Security getSecurity() { return security; }
    public void setSecurity(Security security) { this.security = security; }
    public Monitor getMonitor() { return monitor; }
    public void setMonitor(Monitor monitor) { this.monitor = monitor; }
    public Legacy getLegacy() { return legacy; }
    public void setLegacy(Legacy legacy) { this.legacy = legacy; }

    public static class Datasource {
        private String connectString = "";
        private String host = "";
        private int port = 1521;
        private String serviceName = "";
        private String sid = "";
        private String username = "";
        private String password = "";
        private int poolMin = 2;
        private int poolMax = 20;

        public String getConnectString() { return connectString; }
        public void setConnectString(String v) { this.connectString = v; }
        public String getHost() { return host; }
        public void setHost(String v) { this.host = v; }
        public int getPort() { return port; }
        public void setPort(int v) { this.port = v; }
        public String getServiceName() { return serviceName; }
        public void setServiceName(String v) { this.serviceName = v; }
        public String getSid() { return sid; }
        public void setSid(String v) { this.sid = v; }
        public String getUsername() { return username; }
        public void setUsername(String v) { this.username = v; }
        public String getPassword() { return password; }
        public void setPassword(String v) { this.password = v; }
        public int getPoolMin() { return poolMin; }
        public void setPoolMin(int v) { this.poolMin = v; }
        public int getPoolMax() { return poolMax; }
        public void setPoolMax(int v) { this.poolMax = v; }
    }

    public static class Security {
        private String jwtSecret = "";
        private String jwtExpires = "8h";
        private String production = "development";
        private String frontendUrl = "";
        private String trustProxy = "false";
        private int rateLimitMax = 1000;
        private int rateLimitAuthMax = 30;

        public String getJwtSecret() { return jwtSecret; }
        public void setJwtSecret(String v) { this.jwtSecret = v; }
        public String getJwtExpires() { return jwtExpires; }
        public void setJwtExpires(String v) { this.jwtExpires = v; }
        public String getProduction() { return production; }
        public void setProduction(String v) { this.production = v; }
        public String getFrontendUrl() { return frontendUrl; }
        public void setFrontendUrl(String v) { this.frontendUrl = v; }
        public String getTrustProxy() { return trustProxy; }
        public void setTrustProxy(String v) { this.trustProxy = v; }
        public int getRateLimitMax() { return rateLimitMax; }
        public void setRateLimitMax(int v) { this.rateLimitMax = v; }
        public int getRateLimitAuthMax() { return rateLimitAuthMax; }
        public void setRateLimitAuthMax(int v) { this.rateLimitAuthMax = v; }

        public boolean isProductionMode() {
            String p = production == null ? "" : production.trim().toLowerCase();
            return p.equals("production") || p.equals("prod") || p.equals("true") || p.equals("1");
        }

        public boolean isTrustProxyEnabled() {
            String p = trustProxy == null ? "" : trustProxy.trim().toLowerCase();
            return p.equals("1") || p.equals("true");
        }
    }

    public static class Monitor {
        private boolean schedulerEnabled = true;
        private String collectIntervalMs = "";
        private int collectConcurrency = 5;
        private int sshConnectMs = 15000;
        private int sshCmdMs = 25000;
        private boolean sshStrictHostKey = false;
        private String sshKnownHosts = "";
        private int targetConnectTimeoutSec = 20;
        private int targetQueryTimeoutSec = 30;
        private boolean mssqlEncrypt = false;
        private boolean mssqlTrustCert = true;

        public boolean isSchedulerEnabled() { return schedulerEnabled; }
        public void setSchedulerEnabled(boolean v) { this.schedulerEnabled = v; }
        public String getCollectIntervalMs() { return collectIntervalMs; }
        public void setCollectIntervalMs(String v) { this.collectIntervalMs = v; }
        public int getCollectConcurrency() { return collectConcurrency; }
        public void setCollectConcurrency(int v) { this.collectConcurrency = v; }
        public int getSshConnectMs() { return sshConnectMs; }
        public void setSshConnectMs(int v) { this.sshConnectMs = v; }
        public int getSshCmdMs() { return sshCmdMs; }
        public void setSshCmdMs(int v) { this.sshCmdMs = v; }
        public boolean isSshStrictHostKey() { return sshStrictHostKey; }
        public void setSshStrictHostKey(boolean v) { this.sshStrictHostKey = v; }
        public String getSshKnownHosts() { return sshKnownHosts; }
        public void setSshKnownHosts(String v) { this.sshKnownHosts = v; }
        public int getTargetConnectTimeoutSec() { return targetConnectTimeoutSec; }
        public void setTargetConnectTimeoutSec(int v) { this.targetConnectTimeoutSec = v; }
        public int getTargetQueryTimeoutSec() { return targetQueryTimeoutSec; }
        public void setTargetQueryTimeoutSec(int v) { this.targetQueryTimeoutSec = v; }
        public boolean isMssqlEncrypt() { return mssqlEncrypt; }
        public void setMssqlEncrypt(boolean v) { this.mssqlEncrypt = v; }
        public boolean isMssqlTrustCert() { return mssqlTrustCert; }
        public void setMssqlTrustCert(boolean v) { this.mssqlTrustCert = v; }
    }

    public static class Legacy {
        private boolean enabled = true;
        private String nodeUrl = "http://127.0.0.1:3001";
        private int timeoutSec = 600;

        public boolean isEnabled() { return enabled; }
        public void setEnabled(boolean v) { this.enabled = v; }
        public String getNodeUrl() { return nodeUrl; }
        public void setNodeUrl(String v) { this.nodeUrl = v; }
        public int getTimeoutSec() { return timeoutSec; }
        public void setTimeoutSec(int v) { this.timeoutSec = v; }
    }
}
