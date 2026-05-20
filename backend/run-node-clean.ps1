# 从 NODE_OPTIONS 中移除无效的 --localstorage-file 后启动 Node（npm 脚本用）。
param(
  [ValidateSet('start', 'dev', 'init-db')]
  [string] $Mode = 'start'
)

. "$PSScriptRoot\sanitize-node-options.ps1"

$root = $PSScriptRoot
switch ($Mode) {
  'dev' {
    $nodemon = Join-Path $root 'node_modules/nodemon/bin/nodemon.js'
    if (-not (Test-Path $nodemon)) {
      Write-Error "nodemon not found: $nodemon (run npm install)"
      exit 1
    }
    & node $nodemon (Join-Path $root 'app.js')
  }
  'init-db' {
    & node (Join-Path $root 'src/utils/initDb.js')
  }
  default {
    & node (Join-Path $root 'app.js')
  }
}
exit $LASTEXITCODE
