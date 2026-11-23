"""AI 助手侧：字节截断、规则式 RCA、条目拆分。python3 -m unittest test_kg_rca -v"""
import unittest

import kg_service
import rca_service


class KgTest(unittest.TestCase):
    def test_byte_trunc_chinese(self):
        s = "表空间使用率过高" * 200
        t = kg_service.byte_trunc(s, 1000)
        self.assertLessEqual(len(t.encode("utf-8")), 1000)
        self.assertTrue(s.startswith(t))

    def test_split_points(self):
        pts = kg_service._split_points("1. 检查 TOP SQL\n2、扩容表空间\n- 清理归档\n随便一句")
        self.assertEqual(len(pts), 3)


class RcaRuleTest(unittest.TestCase):
    def test_rule_rca_cpu(self):
        body, conf = rca_service._rule_based_rca({}, {"cpu": [1]}, "CPU 使用率告警")
        self.assertIn("CPU", body)
        self.assertIn("置信度", body)
        self.assertGreater(conf, 0)

    def test_rule_rca_unknown_low_confidence(self):
        body, conf = rca_service._rule_based_rca({}, {}, "某个无法识别的告警")
        self.assertLess(conf, 50)


if __name__ == "__main__":
    unittest.main()
