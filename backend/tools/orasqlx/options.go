package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
)

type AIOptions struct {
	Enabled  bool
	Provider string // ollama | openai
	URL      string
	Model    string
	Key      string
	Timeout  int
}

type Thresholds struct {
	ElapsedSec float64 // R01
	BigRows    float64 // R02
	HitPct     float64 // R04
	IOPct      float64 // R05
	GCPct      float64 // R06
	SkewPct    float64 // R09
	ErrRatio   float64 // R03
	BigTable   float64 // R13 大表行数
	CFRatio    float64 // R17
}

type Options struct {
	SQLIDs  []string
	SQLID   string
	Connect string
	PDB     string

	Out         string
	Format      string // docx | html | json
	Demo        bool
	Input       string
	InputDir    string
	Snapshot    string
	SnapshotDir string
	Compare     string
	KeepFind    bool
	RulesOnly   bool
	PerReport   bool
	ReportDir   string

	NoAWR      bool
	AWRDays    int
	Sample     bool
	SampleTab  string
	SampleCols string
	SamplePct  float64
	MaskBinds  bool
	Parallel   int
	TimeoutSec int
	Rules      string // 例: "R01,R02" 仅启用；"-R12,-R17" 排除
	Th         Thresholds
	AI         AIOptions

	ListRules bool
	DryRun    bool
	DryTable  string
	Check     bool
	ShowVer   bool
}

var boolFlags = map[string]bool{
	"demo": true, "no-awr": true, "sample": true, "rules-only": true, "per-report": true,
	"keep-findings": true, "list-rules": true, "dry-run": true, "check": true, "version": true,
	"ai": true, "no-mask-binds": true, "h": true, "help": true,
}

const usageText = `orasqlx — Oracle SQL 智能诊断与优化建议（单文件 Linux 二进制，无需安装，默认只读）

用法:
  orasqlx <SQL_ID[,SQL_ID...]> --connect user/pwd@host:1521/service [选项]

连接:
  -c, --connect STR     EZConnect 连接串 user/pwd@host:port/service（也可用环境变量 ORASQLX_CONNECT）
                        省略密码时读取环境变量 ORASQLX_PWD，仍为空则从终端读一行（密码不进 ps / history）
      --pdb NAME        CDB 环境切换到指定 PDB（ALTER SESSION SET CONTAINER）；直连 PDB 服务名则无需此项
      --timeout SEC     单条采集 SQL 超时，默认 60
      --parallel N      批量多 SQL_ID 并发连接数，默认 1（复用单连接）

输出:
  -o, --out FILE        输出文件；默认 <SQL_ID>_diag.docx；"-" 写到 stdout
      --format F        docx（默认）| html | json
      --rules-only      只在终端打印规则结论，不生成报告文件
      --per-report      批量时额外给每个 SQL_ID 输出完整报告到 --report-dir
      --report-dir DIR  默认 ./reports
      --snapshot FILE   保存本次采集快照（JSON），供离线复跑规则 / 优化前后对比
      --snapshot-dir D  批量时每个 SQL_ID 一份快照
      --compare FILE    与历史快照对比（优化前 vs 优化后），结果置于报告最前

授权:

离线 / 演示:
      --input F[,F..]   读取快照文件，不连库，重新跑规则
      --input-dir DIR   读取目录下全部 *.json 快照
      --keep-findings   离线时保留快照里已有结论，不重算
      --demo            内置样例数据，无需数据库

采集控制:
      --awr-days N      AWR/ASH 历史窗口天数，默认 2；0 = 全部保留期
      --no-awr          跳过 AWR/ASH（Diagnostics Pack 授权敏感）；默认按 control_management_pack_access 自动判断
      --sample          显式开启字段值频率采样（会读表，默认关闭）
      --sample-table T  OWNER.TABLE
      --sample-cols C   COL1,COL2
      --sample-pct N    块采样比例，默认 1
      --no-mask-binds   报告中不脱敏字符串型绑定变量值（默认脱敏）

规则:
      --rules SPEC      "R01,R07" 只跑这些；"-R12,-R17" 排除这些
      --list-rules      列出全部规则
      --th-elapsed S    R01 单次耗时阈值秒，默认 60
      --th-rows N       R02 大结果集行数，默认 1000000
      --th-hit P        R04 命中率阈值%，默认 90
      --th-io P         R05 IO 等待占比%，默认 40
      --th-gc P         R06 集群等待占比%，默认 15
      --th-skew P       R09 倾斜占比%，默认 60
      --th-err X        R03 估算偏差倍数，默认 10

AI（可选，规则引擎独立，AI 只做归纳）:
      --ai              启用；--ai-provider ollama|openai  --ai-url URL  --ai-model M  （密钥用 ORASQLX_AI_KEY）

其它:
      --dry-run         只列出将要执行的采集 SQL（加 -o x.sql 写成可在 sqlplus 跑的脚本；--dry-table OWNER.TABLE 指定示例表）
      --check           只检查连接、版本、架构、权限，不采集
      --version / -h
`

func parseCLI(args []string) (Options, error) {
	o := Options{
		Format: "docx", Parallel: 1, TimeoutSec: 60, SamplePct: 1, MaskBinds: true,
		ReportDir: "reports",
		Th: Thresholds{ElapsedSec: 60, BigRows: 1000000, HitPct: 90, IOPct: 40, GCPct: 15,
			SkewPct: 60, ErrRatio: 10, BigTable: 1000000, CFRatio: 0.8},
		AI: AIOptions{Provider: "ollama", URL: "http://127.0.0.1:11434", Model: "qwen2.5:14b", Timeout: 120},
	}
	fs := flag.NewFlagSet(toolName, flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	fs.Usage = func() { fmt.Fprint(os.Stderr, usageText) }

	var noMask bool
	fs.StringVar(&o.Connect, "connect", os.Getenv("ORASQLX_CONNECT"), "")
	fs.StringVar(&o.Connect, "c", os.Getenv("ORASQLX_CONNECT"), "")
	fs.StringVar(&o.PDB, "pdb", "", "")
	fs.StringVar(&o.Out, "out", "", "")
	fs.StringVar(&o.Out, "o", "", "")
	fs.StringVar(&o.Format, "format", "docx", "")
	fs.BoolVar(&o.Demo, "demo", false, "")
	fs.StringVar(&o.Input, "input", "", "")
	fs.StringVar(&o.InputDir, "input-dir", "", "")
	fs.StringVar(&o.Snapshot, "snapshot", "", "")
	fs.StringVar(&o.SnapshotDir, "snapshot-dir", "", "")
	fs.StringVar(&o.Compare, "compare", "", "")
	fs.BoolVar(&o.KeepFind, "keep-findings", false, "")
	fs.BoolVar(&o.RulesOnly, "rules-only", false, "")
	fs.BoolVar(&o.PerReport, "per-report", false, "")
	fs.StringVar(&o.ReportDir, "report-dir", "reports", "")
	fs.BoolVar(&o.NoAWR, "no-awr", false, "")
	fs.IntVar(&o.AWRDays, "awr-days", 2, "")
	fs.BoolVar(&o.Sample, "sample", false, "")
	fs.StringVar(&o.SampleTab, "sample-table", "", "")
	fs.StringVar(&o.SampleCols, "sample-cols", "", "")
	fs.Float64Var(&o.SamplePct, "sample-pct", 1, "")
	fs.BoolVar(&noMask, "no-mask-binds", false, "")
	fs.IntVar(&o.Parallel, "parallel", 1, "")
	fs.IntVar(&o.TimeoutSec, "timeout", 60, "")
	fs.StringVar(&o.Rules, "rules", "", "")
	fs.Float64Var(&o.Th.ElapsedSec, "th-elapsed", 60, "")
	fs.Float64Var(&o.Th.BigRows, "th-rows", 1000000, "")
	fs.Float64Var(&o.Th.HitPct, "th-hit", 90, "")
	fs.Float64Var(&o.Th.IOPct, "th-io", 40, "")
	fs.Float64Var(&o.Th.GCPct, "th-gc", 15, "")
	fs.Float64Var(&o.Th.SkewPct, "th-skew", 60, "")
	fs.Float64Var(&o.Th.ErrRatio, "th-err", 10, "")
	fs.BoolVar(&o.ListRules, "list-rules", false, "")
	fs.BoolVar(&o.DryRun, "dry-run", false, "")
	fs.StringVar(&o.DryTable, "dry-table", "", "")
	fs.BoolVar(&o.Check, "check", false, "")
	fs.BoolVar(&o.ShowVer, "version", false, "")
	fs.BoolVar(&o.AI.Enabled, "ai", false, "")
	fs.StringVar(&o.AI.Provider, "ai-provider", "ollama", "")
	fs.StringVar(&o.AI.URL, "ai-url", o.AI.URL, "")
	fs.StringVar(&o.AI.Model, "ai-model", o.AI.Model, "")

	// 允许 SQL_ID 出现在任意位置：先把位置参数摘出来，再交给 flag 解析。
	var flagArgs, pos []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		if strings.HasPrefix(a, "-") && a != "-" {
			flagArgs = append(flagArgs, a)
			name := strings.TrimLeft(a, "-")
			if !strings.Contains(a, "=") && !boolFlags[name] && i+1 < len(args) {
				i++
				flagArgs = append(flagArgs, args[i])
			}
			continue
		}
		pos = append(pos, a)
	}
	if err := fs.Parse(flagArgs); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return o, flag.ErrHelp
		}
		return o, err
	}
	o.MaskBinds = !noMask
	o.AI.Key = os.Getenv("ORASQLX_AI_KEY")
	o.Format = strings.ToLower(o.Format)
	if _, ok := reportExt[o.Format]; !ok {
		return o, fmt.Errorf("--format 只支持 docx / html / json，收到 %q", o.Format)
	}
	if o.Parallel < 1 {
		o.Parallel = 1
	}
	for _, p := range pos {
		for _, id := range strings.Split(p, ",") {
			id = strings.TrimSpace(id)
			if id == "" {
				continue
			}
			if !sqlIDRe.MatchString(id) {
				return o, fmt.Errorf("SQL_ID %q 格式不对（应为 13 位字母数字）", id)
			}
			o.SQLIDs = append(o.SQLIDs, id)
		}
	}
	o.SQLIDs = uniq(o.SQLIDs)
	curTh = o.Th
	if len(o.SQLIDs) == 1 {
		o.SQLID = o.SQLIDs[0]
	}
	if o.Sample && (o.SampleTab == "" || o.SampleCols == "") {
		return o, fmt.Errorf("--sample 需要同时给 --sample-table OWNER.TABLE 与 --sample-cols COL1,COL2")
	}
	return o, nil
}
