package com.dbops.cmdb;

import com.dbops.common.R;
import com.dbops.monitor.DbType;
import org.apache.poi.ss.usermodel.Cell;
import org.apache.poi.ss.usermodel.CellStyle;
import org.apache.poi.ss.usermodel.CellType;
import org.apache.poi.ss.usermodel.DataFormatter;
import org.apache.poi.ss.usermodel.FillPatternType;
import org.apache.poi.ss.usermodel.Font;
import org.apache.poi.ss.usermodel.IndexedColors;
import org.apache.poi.ss.usermodel.Row;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.ss.usermodel.Workbook;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.springframework.stereotype.Service;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 实例批量导入 Excel（多 Sheet，对应 Node services/cmdbInstanceExcelService.js）。
 * [fix] 富文本/公式单元格的密码在 Node 版会变成 "[object Object]"；这里统一用 DataFormatter 取显示值。
 */
@Service
public class CmdbExcelService {

    record SheetSpec(String name, String dbType, int port, String charset) {
    }

    static final List<SheetSpec> SHEETS = List.of(
            new SheetSpec("Oracle", "ORACLE", 1521, "AL32UTF8"),
            new SheetSpec("MySQL", "MYSQL", 3306, "utf8mb4"),
            new SheetSpec("PostgreSQL", "POSTGRESQL", 5432, "UTF8"),
            new SheetSpec("PanWeiDB", "PANWEI", 5432, "UTF8"),
            new SheetSpec("SQL Server", "SQLSERVER", 1433, "UTF-8"),
            new SheetSpec("Dameng", "DAMENG", 5236, "UTF-8"),
            new SheetSpec("GoldenDB", "GOLDENDB", 3306, "utf8mb4"),
            new SheetSpec("其他", null, 1521, ""));

    static final List<String> HEADERS_OTHER = List.of("数据库类型", "实例名称", "主机IP", "端口", "SID", "Service名", "DB用户", "DB密码",
            "版本", "字符集", "环境", "业务线", "标签", "角色");
    static final List<String> HEADERS_STD = HEADERS_OTHER.subList(1, HEADERS_OTHER.size());
    private static final int[] WIDTHS_STD = {22, 16, 8, 12, 16, 12, 14, 14, 14, 12, 10, 14, 16};

    public byte[] buildTemplate() throws IOException {
        try (Workbook wb = new XSSFWorkbook(); ByteArrayOutputStream bos = new ByteArrayOutputStream()) {
            CellStyle head = wb.createCellStyle();
            Font bold = wb.createFont();
            bold.setBold(true);
            head.setFont(bold);
            head.setFillForegroundColor(IndexedColors.GREY_25_PERCENT.getIndex());
            head.setFillPattern(FillPatternType.SOLID_FOREGROUND);
            for (SheetSpec spec : SHEETS) {
                Sheet ws = wb.createSheet(spec.name());
                ws.createFreezePane(0, 1);
                List<String> headers = spec.dbType() != null ? HEADERS_STD : HEADERS_OTHER;
                int offset = spec.dbType() != null ? 0 : 1;
                for (int i = 0; i < headers.size(); i++) {
                    int w = i - offset >= 0 && i - offset < WIDTHS_STD.length ? WIDTHS_STD[i - offset] : 14;
                    ws.setColumnWidth(i, w * 256);
                }
                Row hr = ws.createRow(0);
                for (int i = 0; i < headers.size(); i++) {
                    Cell c = hr.createCell(i);
                    c.setCellValue(headers.get(i));
                    c.setCellStyle(head);
                }
                Map<String, Object> ex = example(spec);
                Row dr = ws.createRow(1);
                for (int i = 0; i < headers.size(); i++) {
                    Object v = ex.get(headers.get(i));
                    Cell c = dr.createCell(i);
                    if (v instanceof Number n) {
                        c.setCellValue(n.doubleValue());
                    } else if (v != null) {
                        c.setCellValue(String.valueOf(v));
                    }
                }
                ws.createRow(2).createCell(0).setCellValue("说明：删除第2行示例后填写数据行。密码列填明文，导入后按平台既有规则写入库。");
            }
            wb.write(bos);
            return bos.toByteArray();
        }
    }

    private static Map<String, Object> example(SheetSpec spec) {
        Map<String, Object> m = new LinkedHashMap<>();
        if (spec.dbType() == null) {
            m.put("数据库类型", "SQLSERVER");
            m.put("实例名称", "其他库-示例");
            m.put("主机IP", "192.168.1.20");
            m.put("端口", 1433);
            m.put("DB用户", "sa");
        } else {
            m.put("实例名称", spec.name() + "-示例");
            m.put("主机IP", "192.168.1.10");
            m.put("端口", spec.port());
            m.put("SID", switch (spec.dbType()) {
                case "ORACLE" -> "ORCL";
                case "MYSQL" -> "mysql";
                case "POSTGRESQL", "PANWEI" -> "postgres";
                case "SQLSERVER" -> "master";
                case "DAMENG" -> "DMSERVER";
                default -> "";
            });
            m.put("Service名", "ORACLE".equals(spec.dbType()) ? "ORCLPDB1" : "");
            m.put("DB用户", switch (spec.dbType()) {
                case "ORACLE" -> "system";
                case "DAMENG" -> "SYSDBA";
                default -> "root";
            });
            m.put("字符集", spec.charset());
        }
        m.put("DB密码", "请改为实际密码");
        m.put("环境", "PROD");
        m.put("角色", "PRIMARY");
        return m;
    }

    static String sheetDbType(String sheetName) {
        String n = sheetName == null ? "" : sheetName.trim();
        String u = n.toUpperCase();
        if (n.equals("Oracle") || u.equals("ORACLE")) {
            return "ORACLE";
        }
        if (n.equals("MySQL") || u.equals("MYSQL")) {
            return "MYSQL";
        }
        if (n.equals("PostgreSQL") || n.equals("PG") || u.equals("POSTGRESQL")) {
            return "POSTGRESQL";
        }
        if (n.equals("PanWeiDB") || n.equals("磐维") || u.equals("PANWEI")) {
            return "PANWEI";
        }
        if (n.equals("SQL Server") || n.equals("SQLServer") || u.equals("SQLSERVER") || u.equals("MSSQL")) {
            return "SQLSERVER";
        }
        if (n.equals("Dameng") || n.equals("达梦")) {
            return "DAMENG";
        }
        if (u.equals("GOLDENDB")) {
            return "GOLDENDB";
        }
        if (n.equals("其他")) {
            return "OTHER";
        }
        return null;
    }

    /** 解析结果行：正常行包含字段；错误行包含 _error/_sheet/_line */
    public List<Map<String, Object>> parse(InputStream in) throws IOException {
        List<Map<String, Object>> out = new ArrayList<>();
        DataFormatter fmt = new DataFormatter();
        try (Workbook wb = new XSSFWorkbook(in)) {
            for (Sheet ws : wb) {
                String st = sheetDbType(ws.getSheetName());
                if (st == null) {
                    continue;
                }
                boolean other = "OTHER".equals(st);
                int off = other ? 1 : 0;
                for (Row row : ws) {
                    int line = row.getRowNum() + 1;
                    if (line == 1) {
                        continue;
                    }
                    String dbType = other ? cell(row, 0, fmt).toUpperCase() : st;
                    String name = cell(row, off, fmt);
                    String ip = cell(row, off + 1, fmt);
                    if (name.isEmpty() || ip.isEmpty() || name.contains("示例") || name.startsWith("说明")) {
                        continue;
                    }
                    if (other && dbType.isEmpty()) {
                        out.add(R.map("_error", ws.getSheetName() + " 第" + line + "行: 须填写数据库类型列", "_sheet", ws.getSheetName(), "_line", line));
                        continue;
                    }
                    dbType = DbType.normalize(dbType);
                    String portStr = cell(row, off + 2, fmt);
                    Integer port = null;
                    if (!portStr.isEmpty()) {
                        try {
                            port = (int) Double.parseDouble(portStr);
                        } catch (NumberFormatException e) {
                            out.add(R.map("_error", ws.getSheetName() + " 第" + line + "行: 端口不是数字", "_sheet", ws.getSheetName(), "_line", line));
                            continue;
                        }
                    }
                    String charset = cell(row, off + 8, fmt);
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("instanceName", name);
                    m.put("dbType", dbType);
                    m.put("hostIp", ip);
                    m.put("port", port != null ? port : DbType.defaultPort(dbType));
                    m.put("sid", emptyToNull(cell(row, off + 3, fmt)));
                    m.put("serviceName", emptyToNull(cell(row, off + 4, fmt)));
                    m.put("dbUser", emptyToNull(cell(row, off + 5, fmt)));
                    m.put("dbPassword", emptyToNull(rawCell(row, off + 6, fmt)));
                    m.put("dbVersion", emptyToNull(cell(row, off + 7, fmt)));
                    m.put("charset", charset.isEmpty() ? emptyToNull(DbType.defaultCharset(dbType)) : charset);
                    m.put("environment", nvl(cell(row, off + 9, fmt), "PROD"));
                    m.put("bizLine", emptyToNull(cell(row, off + 10, fmt)));
                    m.put("tags", emptyToNull(cell(row, off + 11, fmt)));
                    m.put("role", nvl(cell(row, off + 12, fmt), "PRIMARY"));
                    m.put("_sheet", ws.getSheetName());
                    m.put("_line", line);
                    out.add(m);
                }
            }
        }
        return out;
    }

    private static String cell(Row row, int idx, DataFormatter fmt) {
        return rawCell(row, idx, fmt).trim();
    }

    private static String rawCell(Row row, int idx, DataFormatter fmt) {
        Cell c = row.getCell(idx);
        if (c == null || c.getCellType() == CellType.BLANK) {
            return "";
        }
        String v = fmt.formatCellValue(c);
        return v == null ? "" : v;
    }

    private static String emptyToNull(String s) {
        return s == null || s.isEmpty() ? null : s;
    }

    private static String nvl(String s, String def) {
        return s == null || s.isEmpty() ? def : s;
    }
}
