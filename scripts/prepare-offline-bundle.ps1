# Prepare offline-bundle for Linux x64 (run on a networked Windows PC).
# Does not overwrite local backend/frontend node_modules.
# Copy offline-bundle/ to the offline Linux server, then: ./start-all.sh start
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Out = Join-Path $Root "offline-bundle"
$NodeVersion = if ($env:NODE_VERSION) { $env:NODE_VERSION } else { "18.20.8" }
$NodeArch = "linux-x64"
$NpmOs = "linux"
$NpmCpu = "x64"

function Need-Cmd([string]$name) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
        throw "[ERROR] missing command: $name"
    }
}

function Download-File([string]$Url, [string]$Dest) {
    Write-Host "  GET $Url"
    & curl.exe -L --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 300 -o $Dest $Url
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $Dest) -or ((Get-Item $Dest).Length -lt 1000000)) {
        throw "download failed or file too small: $Url"
    }
}

Need-Cmd node
Need-Cmd npm
Need-Cmd tar

Write-Host "============================================"
Write-Host "  Prepare offline-bundle -> $Out"
Write-Host "  Target: Linux x64"
Write-Host "============================================"

if (Test-Path $Out) {
    Get-ChildItem $Out -Force | Remove-Item -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $Out | Out-Null
foreach ($d in @("npm-cache", "archives", "python\wheels", "staging")) {
    New-Item -ItemType Directory -Force -Path (Join-Path $Out $d) | Out-Null
}

$NodeTar = "node-v$NodeVersion-$NodeArch.tar.xz"
$NodeTarPath = Join-Path $Out $NodeTar
$NodeUrls = @(
    "https://npmmirror.com/mirrors/node/v$NodeVersion/$NodeTar",
    "https://cdn.npmmirror.com/binaries/node/v$NodeVersion/$NodeTar",
    "https://nodejs.org/dist/v$NodeVersion/$NodeTar"
)
Write-Host "[1/5] Download Node.js v$NodeVersion ($NodeArch)..."
$ok = $false
foreach ($u in $NodeUrls) {
    try {
        Download-File $u $NodeTarPath
        $ok = $true
        break
    } catch {
        Write-Host "  [WARN] $($_.Exception.Message)"
        Remove-Item $NodeTarPath -Force -ErrorAction SilentlyContinue
    }
}
if (-not $ok) { throw "cannot download Node.js binary" }

$nodeMb = [math]::Round((Get-Item $NodeTarPath).Length / 1MB, 1)
Write-Host "  Node tarball size: $nodeMb MB (keep tarball only, extract on Linux)"

$env:NPM_CONFIG_CACHE = Join-Path $Out "npm-cache"
$env:NPM_CONFIG_AUDIT = "false"
$env:NPM_CONFIG_FUND = "false"
$npmRegistry = "https://registry.npmmirror.com"

function Pack-NpmProject([string]$Name, [string]$SrcDir) {
    Write-Host "[INFO] Download $Name npm deps (linux/x64)..."
    $tmp = Join-Path $Out "staging\$Name"
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    Copy-Item (Join-Path $SrcDir "package.json") $tmp
    $lock = Join-Path $SrcDir "package-lock.json"
    if (Test-Path $lock) { Copy-Item $lock $tmp }
    Push-Location $tmp
    try {
        npm install --os=$NpmOs --cpu=$NpmCpu --libc=glibc --ignore-scripts --no-audit --no-fund --registry=$npmRegistry
        if ($LASTEXITCODE -ne 0) { throw "npm install $Name failed" }
        tar -czf (Join-Path $Out "archives\$Name-node_modules.tgz") node_modules
    } finally {
        Pop-Location
    }
}

Write-Host "[2/5] Pack backend npm deps..."
Pack-NpmProject "backend" (Join-Path $Root "backend")

Write-Host "[3/5] Pack frontend npm deps..."
Pack-NpmProject "frontend" (Join-Path $Root "frontend")

Write-Host "[4/5] Download Python wheels (manylinux x86_64)..."
$WheelsDir = Join-Path $Out "python\wheels"
$Py = $null
foreach ($c in @("py", "python", "python3")) {
    if (Get-Command $c -ErrorAction SilentlyContinue) { $Py = $c; break }
}
if ($Py) {
    $reqs = @(
        (Join-Path $Root "backend\sql-optimizer-agent\requirements.txt"),
        (Join-Path $Root "backend\ai-ops-agent\requirements.txt")
    )
    foreach ($req in $reqs) {
        if (-not (Test-Path $req)) { continue }
        Write-Host "  pip download $req"
        $got = $false
        foreach ($pyv in @("39", "310", "311", "312")) {
            & $Py -m pip download -r $req -d $WheelsDir `
                --platform manylinux2014_x86_64 `
                --python-version $pyv `
                --implementation cp `
                --only-binary=:all: `
                --index-url https://pypi.tuna.tsinghua.edu.cn/simple
            if ($LASTEXITCODE -eq 0) { $got = $true; break }
        }
        if (-not $got) {
            Write-Host "  [WARN] platform-specific download failed, fallback to generic pip download"
            & $Py -m pip download -r $req -d $WheelsDir --index-url https://pypi.tuna.tsinghua.edu.cn/simple
        }
    }
} else {
    Write-Host "[WARN] Python not found, skip wheels"
}

Remove-Item (Join-Path $Out "staging") -Recurse -Force -ErrorAction SilentlyContinue

$Manifest = @"
DIOps offline-bundle
Node: v$NodeVersion $NodeArch
Created: $(Get-Date -Format "yyyy-MM-ddTHH:mm:ss")
Host: $env:COMPUTERNAME (Windows prep)

Contents:
  node-v$NodeVersion-$NodeArch.tar.xz   Node.js Linux binary (extract on target)
  npm-cache/                     npm cache
  archives/backend-node_modules.tgz
  archives/frontend-node_modules.tgz
  python/wheels/                 pip wheels

On offline Linux:
  put this folder at the project root, then:
    ./start-all.sh start
  or:
    bash scripts/install-deps.sh --offline
    ./start-all.sh start
"@
[System.IO.File]::WriteAllText((Join-Path $Out "MANIFEST.txt"), $Manifest)

Write-Host "[5/5] Done."
Write-Host ""
Write-Host "Copy the whole offline-bundle folder to the offline Linux server (project root)."
$size = (Get-ChildItem $Out -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
if ($size) {
    $mb = [math]::Round($size / 1MB, 1)
    Write-Host "  Approx size: $mb MB"
}
Get-ChildItem $Out | Format-Table Name, Mode, Length
