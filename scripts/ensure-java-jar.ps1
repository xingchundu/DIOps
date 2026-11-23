# 确保 dbops-server\target\dbops-server.jar 存在且不比源码旧；需要时用 Maven 重新构建。
# 退出码：0 = jar 可用；1 = 不可用（无 jar 且无法构建，或构建失败）
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$srv = Join-Path $root 'dbops-server'
$jar = Join-Path $srv 'target\dbops-server.jar'

$stale = $true
if (Test-Path $jar) {
  $jarTime = (Get-Item $jar).LastWriteTime
  $newer = Get-ChildItem -Path (Join-Path $srv 'src\main'), (Join-Path $srv 'pom.xml') -Recurse -File |
    Where-Object { $_.LastWriteTime -gt $jarTime } | Select-Object -First 1
  $stale = [bool]$newer
}
if (-not $stale) { exit 0 }

if (-not (Get-Command mvn -ErrorAction SilentlyContinue)) {
  if (Test-Path $jar) {
    Write-Host '[ERROR] dbops-server.jar 比源码旧，且未找到 Maven（mvn），无法重新构建。请安装 Maven 3.8+ 后执行：cd dbops-server; mvn -DskipTests package' -ForegroundColor Red
  } else {
    Write-Host "[ERROR] 未找到 $jar，且未找到 Maven（mvn）。需要 JDK 17+ 与 Maven 3.8+" -ForegroundColor Red
  }
  exit 1
}
Write-Host '[INFO] 源码有更新，重新构建 dbops-server（mvn -DskipTests package）...' -ForegroundColor Cyan
Push-Location $srv
try {
  & mvn -q -DskipTests package
  if ($LASTEXITCODE -ne 0) { Write-Host '[ERROR] dbops-server 构建失败' -ForegroundColor Red; exit 1 }
} finally { Pop-Location }
Write-Host "[OK] 构建完成: $jar" -ForegroundColor Green
exit 0
