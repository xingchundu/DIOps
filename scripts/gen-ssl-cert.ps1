# 生成本地/内网 HTTPS 自签名证书（Nginx + Vite 开发共用）
$ErrorActionPreference = 'Stop'

$CertDir = Join-Path (Split-Path $PSScriptRoot -Parent) 'certs'
$KeyFile = Join-Path $CertDir 'server.key'
$CrtFile = Join-Path $CertDir 'server.crt'

New-Item -ItemType Directory -Force -Path $CertDir | Out-Null

if ((Test-Path $KeyFile) -and (Test-Path $CrtFile)) {
  Write-Host "[OK] Certificate already exists: $CrtFile"
  exit 0
}

function Get-OpenSslPath {
  $cmd = Get-Command openssl -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($p in @(
    "${env:ProgramFiles}\Git\usr\bin\openssl.exe",
    "${env:ProgramFiles(x86)}\Git\usr\bin\openssl.exe"
  )) {
    if (Test-Path $p) { return $p }
  }
  return $null
}

$openssl = Get-OpenSslPath
if (-not $openssl) {
  Write-Host '[ERROR] openssl not found. Install OpenSSL or Git for Windows.'
  exit 1
}

& $openssl req -x509 -nodes -days 3650 -newkey rsa:2048 `
  -keyout $KeyFile `
  -out $CrtFile `
  -subj '/CN=localhost' `
  -addext 'subjectAltName=DNS:localhost,DNS:*.localhost,IP:127.0.0.1,IP:::1'

Write-Host "[OK] Self-signed certificate generated:"
Write-Host "     $CrtFile"
Write-Host "     $KeyFile"
