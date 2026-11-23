package main

import (
	"context"
	"strings"
	"testing"
)

func TestCollectPathWithRecorder(t *testing.T) {
	s, err := collect(context.Background(), recDB{}, Options{TimeoutSec: 5, MaskBinds: true}, "0000000000000")
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Audit) < 20 {
		t.Fatalf("采集语句过少: %d", len(s.Audit))
	}
	for _, a := range s.Audit {
		l := strings.ToUpper(a[strings.Index(a, "] ")+2:])
		if !strings.HasPrefix(l, "SELECT") {
			t.Fatalf("出现非 SELECT 语句: %s", a)
		}
	}
}

func TestDemoRules(t *testing.T) {
	s := demoBase()
	if bad := demoSanity(s); len(bad) > 0 {
		t.Fatal(bad)
	}
	c := countSev(s.Findings)
	if c != [3]int{4, 8, 3} {
		t.Fatalf("demo 命中分布异常: %v", c)
	}
	if _, err := buildDocx(s); err != nil {
		t.Fatal(err)
	}
}

func TestParseSQL(t *testing.T) {
	in := parseSQL(`select a.x from s.t1 a, t2 b join t3 c on b.i=c.i where a.id=:1`)
	if len(in.Tables) != 3 || in.BindCount != 1 {
		t.Fatalf("%+v", in)
	}
}

func TestLitRejectsInjection(t *testing.T) {
	if _, err := lit("X'; DROP TABLE T--"); err == nil {
		t.Fatal("应拒绝")
	}
}
