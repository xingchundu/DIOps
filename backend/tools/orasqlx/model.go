package main

import (
	"fmt"
	"sort"
	"strings"
)

const (
	toolName    = "orasqlx"
	toolVersion = "2.0.0"
	snapSchema  = 2
)

// Severity: 0 严重 / 1 警告 / 2 提示
type Severity int

var sevLabel = [3]string{"严重", "警告", "提示"}

var reportExt = map[string]string{"docx": "docx", "html": "html", "json": "json"}

// Section 是一个采集章节：表格（Cols+Rows）或文本块（Kind=text）。
type Section struct {
	Key   string     `json:"key"`
	Title string     `json:"title"`
	Note  string     `json:"note,omitempty"`
	Err   string     `json:"err,omitempty"`
	Kind  string     `json:"kind,omitempty"` // "" = table, "text" = 等宽文本块
	Cols  []string   `json:"cols,omitempty"`
	Rows  [][]string `json:"rows,omitempty"`
}

// Maps 把表格章节转为 []map，供规则引擎读取（列名大写）。
func (s *Section) Maps() []map[string]string {
	if s == nil {
		return nil
	}
	out := make([]map[string]string, 0, len(s.Rows))
	for _, r := range s.Rows {
		m := make(map[string]string, len(s.Cols))
		for i, c := range s.Cols {
			if i < len(r) {
				m[strings.ToUpper(c)] = r[i]
			}
		}
		out = append(out, m)
	}
	return out
}

type Finding struct {
	ID         string   `json:"id"`
	Severity   Severity `json:"severity"`
	Problem    string   `json:"problem"`
	Evidence   []string `json:"evidence"`
	Suggestion string   `json:"suggestion"`
	SQL        string   `json:"sql,omitempty"`      // 候选 SQL（仅供测试环境验证）
	Rollback   string   `json:"rollback,omitempty"` // 回滚脚本
	Risk       string   `json:"risk"`
	Verify     string   `json:"verify"`
	Confidence float64  `json:"confidence"`
	Source     string   `json:"source"`           // rule:Rxx / ai
	Effort     string   `json:"effort,omitempty"` // 低/中/高：实施成本
}

type Metrics struct {
	Execs     float64 `json:"execs"`
	ElapsedUS float64 `json:"elapsed_us"`
	CPUUS     float64 `json:"cpu_us"`
	UserIOUS  float64 `json:"user_io_us"`
	ClusterUS float64 `json:"cluster_us"`
	ApplUS    float64 `json:"appl_us"`
	ConcUS    float64 `json:"conc_us"`
	LIO       float64 `json:"lio"`
	PIO       float64 `json:"pio"`
	RowsProc  float64 `json:"rows_proc"`
	Fetches   float64 `json:"fetches"`
	Children  int     `json:"children"`
	PlanCount int     `json:"plan_count"`
	BlockSize float64 `json:"block_size"`
}

type Meta struct {
	SQLID      string  `json:"sql_id"`
	DBName     string  `json:"db_name"`
	Mode       string  `json:"mode"` // online / offline / demo
	Banner     string  `json:"banner"`
	Version    string  `json:"version"`
	Major      int     `json:"major"`
	Edition    string  `json:"edition"`
	RAC        bool    `json:"rac"`
	Instances  int     `json:"instances"`
	CDB        bool    `json:"cdb"`
	Container  string  `json:"container"`
	ConID      string  `json:"con_id"`
	AWREnabled bool    `json:"awr_enabled"`
	AIEnabled  bool    `json:"ai_enabled"`
	AIProvider string  `json:"ai_provider"`
	Generated  string  `json:"generated"`
	Module     string  `json:"module"`
	SQLType    string  `json:"sql_type"`
	Parsing    string  `json:"parsing_schema"`
	CollectSec float64 `json:"collect_sec"`
}

type Snapshot struct {
	Schema    int       `json:"schema"`
	Meta      Meta      `json:"meta"`
	Metrics   Metrics   `json:"metrics"`
	SQLText   string    `json:"sql_text"`
	Sections  []Section `json:"sections"`
	Findings  []Finding `json:"findings"`
	Errors    []string  `json:"errors,omitempty"`
	Audit     []string  `json:"audit,omitempty"` // 采集期间执行过的全部只读 SQL
	AuditFull []string  `json:"-"`
	AISummary string    `json:"ai_summary,omitempty"`
	AIError   string    `json:"ai_error,omitempty"`
}

func (s *Snapshot) Sec(key string) *Section {
	for i := range s.Sections {
		if s.Sections[i].Key == key {
			return &s.Sections[i]
		}
	}
	return nil
}

// AWR / ASH 章节需要 Diagnostics Pack 授权。
func isAWRKey(k string) bool {
	switch k {
	case "ash", "ashhist", "ashline", "ashobj", "ashtime", "awrtrend", "awrplansum", "awrplan", "awrxplan":
		return true
	}
	return false
}

type BatchItem struct {
	SQLID string
	Snap  *Snapshot
	Err   error
}

type BatchReport struct {
	Items       []BatchItem
	AISummaries [][2]string
	Generated   string
	Opts        Options
}

func countSev(fs []Finding) [3]int {
	var c [3]int
	for _, f := range fs {
		if f.Severity >= 0 && int(f.Severity) < 3 {
			c[f.Severity]++
		}
	}
	return c
}

func sortFindings(fs []Finding) {
	sort.SliceStable(fs, func(i, j int) bool {
		if fs[i].Severity != fs[j].Severity {
			return fs[i].Severity < fs[j].Severity
		}
		return fs[i].Confidence > fs[j].Confidence
	})
}

func (m Metrics) PerExecSec() float64 { return div(m.ElapsedUS, m.Execs) / 1e6 }
func (m Metrics) HitRatio() float64   { return pct(m.LIO-m.PIO, m.LIO) }

func envLine(s *Snapshot) string {
	m := s.Meta
	arch := "非 CDB 单库"
	if m.CDB {
		arch = "CDB/PDB 多租户"
		if m.Container != "" {
			arch += fmt.Sprintf("，容器 %s (CON_ID=%s)", m.Container, blankTo(m.ConID, "?"))
		}
	}
	return fmt.Sprintf("%s / 架构 %s / 实例 %d / RAC %v / AWR %v / AI %v / 章节 %d",
		blankTo(m.Banner, "Oracle"), arch, m.Instances, m.RAC, m.AWREnabled, m.AIEnabled, len(s.Sections))
}
