package com.dbops.monitor;

import com.jcraft.jsch.ChannelExec;
import com.jcraft.jsch.JSch;
import com.jcraft.jsch.JSchException;
import com.jcraft.jsch.Session;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Properties;

/**
 * 一次采集复用一个 SSH 会话执行多条白名单命令。
 * <p>
 * [改进] Node 版每条命令单独建一次 SSH 连接（一轮主机采集 8~10 次握手）；这里一轮只握手一次。
 * [安全] 默认不校验主机指纹（与 Node 版一致）；生产建议设置 MONITOR_SSH_STRICT_HOST_KEY=true 并提供 known_hosts。
 */
public final class SshSession implements AutoCloseable {

    public record Result(int code, String stdout, String stderr) {
    }

    private static final int MAX_BYTES = 512 * 1024;
    private final Session session;

    private SshSession(Session session) {
        this.session = session;
    }

    public static SshSession connect(String host, int port, String user, String password, String privateKey,
                                     int connectTimeoutMs, boolean strictHostKey, String knownHosts) throws JSchException {
        JSch jsch = new JSch();
        if (privateKey != null && !privateKey.isBlank()) {
            jsch.addIdentity("dbops-host-key", privateKey.getBytes(StandardCharsets.UTF_8), null, null);
        }
        if (strictHostKey) {
            // 未单独配置时使用运行账号的 ~/.ssh/known_hosts（先在平台服务器上 ssh-keyscan 目标主机写入）
            String kh = knownHosts != null && !knownHosts.isBlank() ? knownHosts
                    : java.nio.file.Paths.get(System.getProperty("user.home"), ".ssh", "known_hosts").toString();
            if (!java.nio.file.Files.isReadable(java.nio.file.Paths.get(kh))) {
                throw new JSchException("已开启 SSH 主机指纹校验，但 known_hosts 文件不可读：" + kh
                        + "（用 ssh-keyscan 写入目标主机指纹，或设置 MONITOR_SSH_KNOWN_HOSTS；内网测试环境可设 MONITOR_SSH_STRICT_HOST_KEY=false）");
            }
            jsch.setKnownHosts(kh);
        }
        Session s = jsch.getSession(user, host, port);
        if (password != null && !password.isEmpty()) {
            s.setPassword(password);
        }
        Properties cfg = new Properties();
        cfg.put("StrictHostKeyChecking", strictHostKey ? "yes" : "no");
        cfg.put("PreferredAuthentications", "publickey,password");
        s.setConfig(cfg);
        s.setServerAliveInterval(10_000);
        s.connect(connectTimeoutMs);
        return new SshSession(s);
    }

    public Result exec(String command, int timeoutMs) throws Exception {
        ChannelExec ch = (ChannelExec) session.openChannel("exec");
        ch.setCommand(command);
        ch.setInputStream(null);
        ByteArrayOutputStream err = new ByteArrayOutputStream();
        ch.setErrStream(err);
        InputStream in = ch.getInputStream();
        ch.connect(Math.min(timeoutMs, 10_000));
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        long deadline = System.currentTimeMillis() + timeoutMs;
        try {
            while (true) {
                while (in.available() > 0) {
                    int n = in.read(buf);
                    if (n < 0) {
                        break;
                    }
                    if (out.size() < MAX_BYTES) {
                        out.write(buf, 0, Math.min(n, MAX_BYTES - out.size()));
                    }
                }
                if (ch.isClosed()) {
                    if (in.available() > 0) {
                        continue;
                    }
                    break;
                }
                if (System.currentTimeMillis() > deadline) {
                    throw new java.util.concurrent.TimeoutException("SSH command timeout after " + timeoutMs + "ms");
                }
                Thread.sleep(50);
            }
            String e = err.toString(StandardCharsets.UTF_8);
            return new Result(ch.getExitStatus(), out.toString(StandardCharsets.UTF_8),
                    e.length() > MAX_BYTES ? e.substring(0, MAX_BYTES) : e);
        } finally {
            ch.disconnect();
        }
    }

    @Override
    public void close() {
        session.disconnect();
    }
}
