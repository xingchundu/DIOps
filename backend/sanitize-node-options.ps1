# 供 dot-source：清理当前进程 NODE_OPTIONS 中无效的 --localstorage-file，避免 Node 启动告警。
# 用法: . path\to\sanitize-node-options.ps1
$opt = $env:NODE_OPTIONS
if ($opt) {
  $arr = $opt -split '\s+'
  $out = [System.Collections.ArrayList]@()
  for ($i = 0; $i -lt $arr.Length; $i++) {
    $t = $arr[$i]
    if ($t -eq '--localstorage-file') {
      # Skip the next token if it's the path value (not another flag)
      if ($i + 1 -lt $arr.Length -and $arr[$i + 1] -notmatch '^-') { $i++ }
      continue
    }
    if ($t -like '--localstorage-file=*') {
      continue
    }
    [void]$out.Add($t)
  }
  $env:NODE_OPTIONS = ($out -join ' ').Trim()
}
if ([string]::IsNullOrWhiteSpace($env:NODE_OPTIONS)) {
  Remove-Item Env:\NODE_OPTIONS -ErrorAction SilentlyContinue
}
