package com.dbops.config;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;

/**
 * 读取 dotenv 格式文件写入 System properties（不覆盖已有环境变量 / -D 参数）。
 * 查找顺序：$DBOPS_ENV_FILE → ./.env → ../backend/.env → ./backend/.env
 */
public final class EnvFileLoader {

    private EnvFileLoader() {
    }

    public static void load() {
        List<Path> candidates = new ArrayList<>();
        String explicit = System.getenv("DBOPS_ENV_FILE");
        if (explicit != null && !explicit.isBlank()) {
            candidates.add(Paths.get(explicit.trim()));
        }
        candidates.add(Paths.get(".env"));
        candidates.add(Paths.get("..", "backend", ".env"));
        candidates.add(Paths.get("backend", ".env"));
        for (Path p : candidates) {
            if (Files.isRegularFile(p)) {
                try {
                    int n = apply(Files.readAllLines(p, StandardCharsets.UTF_8));
                    System.out.println("[env] loaded " + n + " keys from " + p.toAbsolutePath().normalize());
                } catch (IOException e) {
                    System.err.println("[env] failed to read " + p + ": " + e.getMessage());
                }
                return;
            }
        }
    }

    static int apply(List<String> lines) {
        int n = 0;
        for (String raw : lines) {
            String line = raw.strip();
            if (line.isEmpty() || line.startsWith("#")) {
                continue;
            }
            if (line.startsWith("export ")) {
                line = line.substring(7).strip();
            }
            int eq = line.indexOf('=');
            if (eq <= 0) {
                continue;
            }
            String key = line.substring(0, eq).strip();
            String val = line.substring(eq + 1).strip();
            if ((val.startsWith("\"") && val.endsWith("\"") && val.length() >= 2)
                    || (val.startsWith("'") && val.endsWith("'") && val.length() >= 2)) {
                val = val.substring(1, val.length() - 1);
            } else {
                int hash = val.indexOf(" #");
                if (hash >= 0) {
                    val = val.substring(0, hash).strip();
                }
            }
            if (System.getenv(key) == null && System.getProperty(key) == null) {
                System.setProperty(key, val);
                n++;
            }
        }
        return n;
    }
}
