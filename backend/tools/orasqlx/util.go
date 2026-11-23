package main

import (
	"fmt"
	"math"
	"os"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

func blankTo(s, def string) string {
	if strings.TrimSpace(s) == "" {
		return def
	}
	return s
}

func div(a, b float64) float64 {
	if b == 0 {
		return 0
	}
	return a / b
}

func pct(a, b float64) float64 {
	if b == 0 {
		return 0
	}
	return a / b * 100
}

func fmtTwo(v float64) string { return strconv.FormatFloat(round(v, 2), 'f', 2, 64) }

func fmtInt(v float64) string {
	return strconv.FormatFloat(math.Round(v), 'f', 0, 64)
}

// fmtSec: 微秒累计值 → 单次秒数（两位小数）
func fmtSec(us, execs float64) string { return fmtTwo(div(us, execs) / 1e6) }

func round(v float64, n int) float64 {
	p := math.Pow(10, float64(n))
	return math.Round(v*p) / p
}

func truncate(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n]) + "…"
}

func num(s string) float64 {
	s = strings.TrimSpace(strings.ReplaceAll(s, ",", ""))
	if s == "" {
		return 0
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0
	}
	return f
}

func hasNum(s string) bool {
	s = strings.TrimSpace(s)
	if s == "" {
		return false
	}
	_, err := strconv.ParseFloat(strings.ReplaceAll(s, ",", ""), 64)
	return err == nil
}

var identRe = regexp.MustCompile(`^[A-Za-z0-9_$#]{1,128}$`)
var sqlIDRe = regexp.MustCompile(`^[0-9a-zA-Z]{13}$`)

// lit 只接受安全标识符并返回单引号字面量，杜绝拼接注入。
func lit(s string) (string, error) {
	if !identRe.MatchString(s) {
		return "", fmt.Errorf("非法标识符 %q", s)
	}
	return "'" + s + "'", nil
}

func dq(s string) string { return `"` + strings.ReplaceAll(s, `"`, ``) + `"` }

func uniq(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, x := range in {
		if x != "" && !seen[x] {
			seen[x] = true
			out = append(out, x)
		}
	}
	return out
}

func joinMax(in []string, n int, sep string) string {
	if len(in) <= n {
		return strings.Join(in, sep)
	}
	return strings.Join(in[:n], sep) + " ..."
}

func ratio(e, a float64) float64 {
	hi, lo := math.Max(e, a), math.Min(e, a)
	return hi / math.Max(lo, 1)
}

func humanBytes(b float64) string {
	switch {
	case b >= 1<<30:
		return fmt.Sprintf("%.1f GB", b/(1<<30))
	case b >= 1<<20:
		return fmt.Sprintf("%.1f MB", b/(1<<20))
	case b >= 1<<10:
		return fmt.Sprintf("%.1f KB", b/(1<<10))
	}
	return fmt.Sprintf("%.0f B", b)
}

var stderr = os.Stderr
