# 首次启动时为 backend\.env 生成强随机密钥（已存在且足够长时不改动）：JWT_SECRET / DBOPS_SECRET_KEY / AI_INTERNAL_TOKEN
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root 'backend\.env'
if (-not (Test-Path $envFile)) { New-Item -ItemType File -Path $envFile | Out-Null }
$lines = [System.Collections.Generic.List[string]](Get-Content -LiteralPath $envFile -Encoding UTF8)
function New-Secret { $b = New-Object byte[] 36; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); ([Convert]::ToBase64String($b) -replace '[/+=]', '').Substring(0, 40) }
$weak = @('', 'dbops_secret', 'dbops_platform_secret_2026')
$changed = $false
foreach ($k in 'JWT_SECRET', 'DBOPS_SECRET_KEY', 'AI_INTERNAL_TOKEN') {
  $cur = ($lines | Where-Object { $_ -match "^$k=" } | Select-Object -Last 1)
  $val = if ($cur) { $cur.Substring($k.Length + 1).Trim() } else { '' }
  if ($weak -contains $val -or $val.Length -lt 16 -or $val.StartsWith('请换成')) {
    $lines.RemoveAll({ param($l) $l -match "^$k=" }) | Out-Null
    $lines.Add("$k=$(New-Secret)")
    Write-Host "[secrets] 已生成 $k（保存在 backend\.env）"
    if ($k -eq 'DBOPS_SECRET_KEY') { Write-Host '[secrets] 请备份 DBOPS_SECRET_KEY：丢失后已保存的被管库密码无法解密' -ForegroundColor Yellow }
    $changed = $true
  }
}
if ($changed) { [System.IO.File]::WriteAllLines($envFile, $lines, (New-Object System.Text.UTF8Encoding $false)) }
