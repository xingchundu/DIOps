"""预检 / 校验 / 规则兜底的单元测试（不连库、不调模型）：python3 -m unittest test_precheck -v"""
import unittest

import rule_report
import sql_precheck
import sql_validator


class PrecheckTest(unittest.TestCase):
    def test_oracle_rejects_mysql_limit(self):
        r = sql_precheck.precheck("select * from t limit 3", "Oracle")
        self.assertFalse(r["ok"])

    def test_oracle_rejects_ifnull_and_top(self):
        self.assertFalse(sql_precheck.precheck("select ifnull(a,0) from t", "ORACLE")["ok"])
        self.assertFalse(sql_precheck.precheck("select top 5 * from t", "ORACLE")["ok"])

    def test_valid_select_passes_for_domestic_dialects(self):
        for t in ("DAMENG", "GOLDENDB", "PANWEI", "达梦"):
            self.assertTrue(sql_precheck.precheck("select a from t where b = 1", t)["ok"], t)

    def test_unclosed_quote_does_not_crash(self):
        r = sql_precheck.precheck("select * from t where n='abc", "MySQL")
        self.assertFalse(r["ok"])
        v = sql_validator.validate_sql("select * from t where n='abc", "Oracle")  # 原来抛 TokenError
        self.assertFalse(v["ok"])

    def test_plsql_block_rejected(self):
        self.assertFalse(sql_precheck.precheck("begin null; end;", "Oracle")["ok"])

    def test_multi_statement_takes_first_with_warning(self):
        r = sql_precheck.precheck("select 1 from dual; select 2 from dual", "Oracle")
        self.assertTrue(r["ok"])
        self.assertEqual(r["statements"], 2)
        self.assertTrue(r["warnings"])
        self.assertNotIn("select 2", r["sql"])

    def test_semicolon_inside_quotes_not_split(self):
        r = sql_precheck.precheck("select 'a;b' from dual", "Oracle")
        self.assertEqual(r["statements"], 1)

    def test_dml_without_where_warns(self):
        r = sql_precheck.precheck("delete from t", "Oracle")
        self.assertTrue(any("WHERE" in w for w in r["warnings"]))

    def test_empty(self):
        self.assertFalse(sql_precheck.precheck("   ", "Oracle")["ok"])
        self.assertFalse(sql_precheck.precheck("-- only comment", "Oracle")["ok"])


class DialectNamesTest(unittest.TestCase):
    NAMES = ["Oracle", "DAMENG", "达梦", "DM", "GOLDENDB", "GoldenDB", "PANWEIDB", "PANWEI", "panweidb", "盘古", "磐维", "PostgreSQL", "MySQL", "SQLSERVER"]
    BAD = ["select * from t where n='abc", "select /* x from t", "select \"a from t", "select `a from t", "((", "'", "select 1 from t where a = $$x"]

    def test_never_raises_and_rejects_broken_sql(self):
        for n in self.NAMES:
            for b in self.BAD:
                r = sql_precheck.precheck(b, n)
                self.assertIn("ok", r, (n, b))
                v = sql_validator.validate_sql(b, n)
                self.assertIn("ok", v, (n, b))
            self.assertFalse(sql_precheck.precheck("select * from t where n='abc", n)["ok"], n)
            self.assertFalse(sql_validator.validate_sql("select * from t where n='abc", n)["ok"], n)

    def test_domestic_dialect_family(self):
        n = sql_validator._normalize_db_type
        self.assertEqual(n("DAMENG"), "oracle")
        self.assertEqual(n("GOLDENDB"), "mysql")
        self.assertEqual(n("PANWEIDB"), "postgres")
        self.assertEqual(n("盘古"), "postgres")


class RuleFallbackTest(unittest.TestCase):
    def test_local_rules_used_when_java_unavailable(self):
        r = rule_report.run_rules("select * from a where x not in (select x from b)", "Oracle")
        self.assertTrue(r["rules"])
        md = rule_report.build_markdown("select 1", "Oracle", r)
        self.assertIn("规则优化报告", md)
        self.assertIn("NOT IN", md)


if __name__ == "__main__":
    unittest.main()
