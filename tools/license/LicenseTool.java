import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.Base64;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * DIOps 授权签发工具（供应商内部使用，不随产品发布；私钥只保存在供应商处）。
 * 单文件、无依赖，JDK 17+ 直接运行：
 *
 * <pre>
 * 1) 生成密钥对（只做一次；换密钥后旧授权全部失效）
 *    java LicenseTool.java genkey --out ~/diops-keys
 *    → private.key（妥善保管）、public.key（复制到 dbops-server/src/main/resources/license/public.key 后重新打包）
 *
 * 2) 客户在登录页 / 授权信息页看到机器码（形如 8F3A-1C2D-55E0-9B7A），发给供应商
 *
 * 3) 签发
 *    java LicenseTool.java issue --key ~/diops-keys/private.key --customer "某某银行" --type YEAR --machine 8F3A-1C2D-55E0-9B7A
 *         [--start 2026-11-10] [--months 3] [--days 15] [--max-instances 50] [--id LIC-…] [--out 某某银行.lic]
 *    --type MONTH = 1 个月，YEAR = 12 个月，TRIAL = --days 天（默认 30），CUSTOM = --months / --days
 *    续期：--start 填旧授权到期日的次日，客户提前导入即可无缝衔接
 *
 * 4) 查看 / 校验
 *    java LicenseTool.java show 某某银行.lic --pub ~/diops-keys/public.key
 *    java LicenseTool.java machine --dbid 1234567890     （按平台库 DBID 计算机器码，用于核对）
 * </pre>
 *
 * canonical 与机器码算法必须与 dbops-server 的 com.dbops.license.LicenseCodec 完全一致。
 */
public class LicenseTool {

    static final String PREFIX = "DIOPS-LICENSE-V1";
    static final ZoneId ZONE = ZoneId.of("Asia/Shanghai");
    static final DateTimeFormatter TS = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss", Locale.ROOT);

    public static void main(String[] args) throws Exception {
        if (args.length == 0) {
            usage();
            return;
        }
        Map<String, String> o = opts(args);
        switch (args[0]) {
            case "genkey" -> genkey(Path.of(req(o, "out")));
            case "machine" -> System.out.println(machineCode(req(o, "dbid")));
            case "issue" -> issue(o);
            case "show" -> show(Path.of(args.length > 1 && !args[1].startsWith("--") ? args[1] : req(o, "file")), o.get("pub"));
            default -> usage();
        }
    }

    static void usage() {
        System.out.println("用法：genkey --out DIR | machine --dbid N | issue --key private.key --customer 名称 --type MONTH|YEAR|TRIAL|CUSTOM --machine 机器码 "
                + "[--start yyyy-MM-dd] [--months N] [--days N] [--max-instances N] [--id ID] [--out 文件] | show 文件 [--pub public.key]");
    }

    static Map<String, String> opts(String[] a) {
        Map<String, String> m = new HashMap<>();
        for (int i = 1; i < a.length; i++) {
            if (a[i].startsWith("--") && i + 1 < a.length) {
                m.put(a[i].substring(2), a[++i]);
            }
        }
        return m;
    }

    static String req(Map<String, String> o, String k) {
        String v = o.get(k);
        if (v == null || v.isBlank()) {
            throw new IllegalArgumentException("缺少参数 --" + k);
        }
        return v.trim();
    }

    static void genkey(Path dir) throws Exception {
        Files.createDirectories(dir);
        Path priv = dir.resolve("private.key");
        if (Files.exists(priv)) {
            throw new IllegalStateException(priv + " 已存在；换密钥会使所有已签发授权失效，如确需更换请先手动移走");
        }
        KeyPair kp = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
        Files.writeString(priv, Base64.getEncoder().encodeToString(kp.getPrivate().getEncoded()) + "\n");
        Files.writeString(dir.resolve("public.key"), Base64.getEncoder().encodeToString(kp.getPublic().getEncoded()) + "\n");
        System.out.println("已生成 " + priv + "（私钥，妥善保管，不要提交到代码库）和 " + dir.resolve("public.key"));
        System.out.println("把 public.key 复制到 dbops-server/src/main/resources/license/public.key 后重新打包");
    }

    static void issue(Map<String, String> o) throws Exception {
        PrivateKey key = KeyFactory.getInstance("Ed25519").generatePrivate(
                new PKCS8EncodedKeySpec(Base64.getDecoder().decode(Files.readString(Path.of(req(o, "key"))).trim())));
        String type = req(o, "type").toUpperCase(Locale.ROOT);
        LocalDate start = o.containsKey("start") ? LocalDate.parse(o.get("start")) : LocalDate.now(ZONE);
        LocalDate end = switch (type) {
            case "MONTH" -> start.plusMonths(Integer.parseInt(o.getOrDefault("months", "1")));
            case "YEAR" -> start.plusMonths(12L * Integer.parseInt(o.getOrDefault("years", "1")));
            case "TRIAL" -> start.plusDays(Integer.parseInt(o.getOrDefault("days", "30")));
            case "CUSTOM" -> start.plusMonths(Integer.parseInt(o.getOrDefault("months", "0"))).plusDays(Integer.parseInt(o.getOrDefault("days", "0")));
            default -> throw new IllegalArgumentException("--type 只能是 MONTH / YEAR / TRIAL / CUSTOM");
        };
        if (!end.isAfter(start)) {
            throw new IllegalArgumentException("到期日必须晚于生效日");
        }
        String machine = req(o, "machine").toUpperCase(Locale.ROOT);
        if (!machine.matches("[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}")) {
            throw new IllegalArgumentException("机器码格式应为 XXXX-XXXX-XXXX-XXXX");
        }
        String id = o.getOrDefault("id", "LIC-" + LocalDateTime.now(ZONE).format(DateTimeFormatter.ofPattern("yyyyMMddHHmmss")));
        String customer = req(o, "customer");
        String issued = LocalDate.now(ZONE).toString();
        String nb = TS.format(start.atStartOfDay());
        String exp = TS.format(end.atTime(LocalTime.of(23, 59, 59)));
        String max = o.getOrDefault("max-instances", "");
        String canonical = String.join("\n", PREFIX, id, customer, type, issued, nb, exp, machine, max);
        Signature s = Signature.getInstance("Ed25519");
        s.initSign(key);
        s.update(canonical.getBytes(StandardCharsets.UTF_8));
        String sig = Base64.getEncoder().encodeToString(s.sign());
        String json = "{\n"
                + "  \"licenseId\": " + q(id) + ",\n"
                + "  \"customer\": " + q(customer) + ",\n"
                + "  \"type\": " + q(type) + ",\n"
                + "  \"issuedAt\": " + q(issued) + ",\n"
                + "  \"notBefore\": " + q(nb) + ",\n"
                + "  \"expiresAt\": " + q(exp) + ",\n"
                + "  \"machineCode\": " + q(machine) + ",\n"
                + "  \"maxInstances\": " + (max.isEmpty() ? "null" : Integer.parseInt(max)) + ",\n"
                + "  \"signature\": " + q(sig) + "\n}\n";
        Path out = Path.of(o.getOrDefault("out", customer.replaceAll("[\\\\/:*?\"<>|\\s]", "_") + "-" + id + ".lic"));
        Files.writeString(out, json);
        System.out.println("已签发 " + out.toAbsolutePath() + "：" + customer + " " + type + " " + nb + " ~ " + exp + " 机器码 " + machine
                + (max.isEmpty() ? "" : " 实例上限 " + max));
    }

    static void show(Path file, String pubPath) throws Exception {
        String c = Files.readString(file);
        Map<String, String> f = new HashMap<>();
        Matcher m = Pattern.compile("\"(\\w+)\"\\s*:\\s*(\"((?:[^\"\\\\]|\\\\.)*)\"|(-?\\d+|null))").matcher(c);
        while (m.find()) {
            f.put(m.group(1), m.group(3) != null ? unq(m.group(3)) : ("null".equals(m.group(4)) ? "" : m.group(4)));
        }
        for (String k : new String[]{"licenseId", "customer", "type", "issuedAt", "notBefore", "expiresAt", "machineCode", "maxInstances"}) {
            System.out.printf("%-13s %s%n", k, f.getOrDefault(k, ""));
        }
        if (pubPath != null) {
            PublicKey pub = KeyFactory.getInstance("Ed25519").generatePublic(
                    new X509EncodedKeySpec(Base64.getDecoder().decode(Files.readString(Path.of(pubPath)).trim())));
            String canonical = String.join("\n", PREFIX, f.get("licenseId"), f.get("customer"), f.get("type"), f.get("issuedAt"),
                    f.get("notBefore"), f.get("expiresAt"), f.get("machineCode"), f.getOrDefault("maxInstances", ""));
            Signature s = Signature.getInstance("Ed25519");
            s.initVerify(pub);
            s.update(canonical.getBytes(StandardCharsets.UTF_8));
            System.out.println("签名         " + (s.verify(Base64.getDecoder().decode(f.get("signature"))) ? "有效" : "无效"));
        }
    }

    static String machineCode(String dbid) throws Exception {
        byte[] h = MessageDigest.getInstance("SHA-256").digest(("DIOPS|DBID|" + dbid.trim()).getBytes(StandardCharsets.UTF_8));
        String hex = HexFormat.of().withUpperCase().formatHex(h).substring(0, 16);
        return hex.substring(0, 4) + "-" + hex.substring(4, 8) + "-" + hex.substring(8, 12) + "-" + hex.substring(12, 16);
    }

    static String q(String s) {
        StringBuilder b = new StringBuilder("\"");
        for (char ch : s.toCharArray()) {
            switch (ch) {
                case '"' -> b.append("\\\"");
                case '\\' -> b.append("\\\\");
                case '\n' -> b.append("\\n");
                case '\r' -> b.append("\\r");
                case '\t' -> b.append("\\t");
                default -> {
                    if (ch < 0x20) {
                        b.append(String.format("\\u%04x", (int) ch));
                    } else {
                        b.append(ch);
                    }
                }
            }
        }
        return b.append('"').toString();
    }

    static String unq(String s) {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            if (ch != '\\' || i + 1 >= s.length()) {
                b.append(ch);
                continue;
            }
            char n = s.charAt(++i);
            switch (n) {
                case 'n' -> b.append('\n');
                case 'r' -> b.append('\r');
                case 't' -> b.append('\t');
                case 'u' -> {
                    b.append((char) Integer.parseInt(s.substring(i + 1, i + 5), 16));
                    i += 4;
                }
                default -> b.append(n);
            }
        }
        return b.toString();
    }
}
