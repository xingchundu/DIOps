package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// AI 层是可选的：规则引擎已给出全部结论，AI 只负责把证据归纳成人话，并明确"需要 DBA 确认的点"。
// 默认指向本机 Ollama，数据不出内网；若指向外部服务，会在终端明确警告。

func runAI(s *Snapshot, ai AIOptions) (string, error) {
	u, err := url.Parse(ai.URL)
	if err != nil {
		return "", err
	}
	h := u.Hostname()
	if h != "127.0.0.1" && h != "localhost" && h != "::1" {
		fmt.Fprintf(stderr, "警告: AI 地址 %s 不是本机，SQL 文本与诊断摘要将发送到该服务\n", ai.URL)
	}
	type fnd struct {
		ID, Problem string
		Evidence    []string
		Suggestion  string
	}
	var fs []fnd
	for _, f := range s.Findings {
		fs = append(fs, fnd{f.ID, f.Problem, f.Evidence, f.Suggestion})
	}
	payload := map[string]any{
		"sql_id": s.Meta.SQLID, "env": envLine(s), "sql_text": truncate(s.SQLText, 3000),
		"per_exec_sec": s.Metrics.PerExecSec(), "hit_ratio_pct": s.Metrics.HitRatio(), "findings": fs,
	}
	pj, _ := json.Marshal(payload)
	sys := "你是资深 Oracle DBA。只能依据给定的 JSON 证据作答，不得编造任何表、索引、数据或数字；证据不足时明确写“证据不足”。" +
		"用中文输出三段：①总体判断（不超过 5 句）；②建议实施的优先级顺序（引用规则编号 Rxx）；③必须由 DBA / 业务方确认的前提与风险。不要给出可直接执行的变更命令。"
	var body []byte
	var endpoint string
	switch ai.Provider {
	case "ollama":
		endpoint = strings.TrimRight(ai.URL, "/") + "/api/chat"
		body, _ = json.Marshal(map[string]any{"model": ai.Model, "stream": false, "messages": []map[string]string{
			{"role": "system", "content": sys}, {"role": "user", "content": string(pj)}}})
	case "openai":
		endpoint = strings.TrimRight(ai.URL, "/") + "/v1/chat/completions"
		body, _ = json.Marshal(map[string]any{"model": ai.Model, "temperature": 0.1, "messages": []map[string]string{
			{"role": "system", "content": sys}, {"role": "user", "content": string(pj)}}})
	default:
		return "", fmt.Errorf("未知 AI provider %q（支持 ollama / openai）", ai.Provider)
	}
	req, _ := http.NewRequest("POST", endpoint, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if ai.Key != "" {
		req.Header.Set("Authorization", "Bearer "+ai.Key)
	}
	cl := &http.Client{Timeout: time.Duration(ai.Timeout) * time.Second}
	resp, err := cl.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode/100 != 2 {
		return "", fmt.Errorf("HTTP %d: %s", resp.StatusCode, truncate(string(raw), 200))
	}
	var out struct {
		Message struct{ Content string } `json:"message"`
		Choices []struct {
			Message struct{ Content string } `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", err
	}
	txt := out.Message.Content
	if txt == "" && len(out.Choices) > 0 {
		txt = out.Choices[0].Message.Content
	}
	if strings.TrimSpace(txt) == "" {
		return "", fmt.Errorf("模型返回为空")
	}
	return strings.TrimSpace(txt), nil
}
