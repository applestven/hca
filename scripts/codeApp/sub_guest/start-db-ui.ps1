# 一键启动 Sub 获客用户状态库网页管理
# 浏览器打开: http://127.0.0.1:8088
#
# 注意：改库前请先停止 HCA / Sub获客脚本，避免和 Electron(sql.js) 同时写坏库。

param(
  [string]$DbDir = "$env:APPDATA\subbox\sub_guest",
  [int]$Port = 8088
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path (Join-Path $DbDir "sub_guest.db"))) {
  Write-Host "找不到数据库: $(Join-Path $DbDir 'sub_guest.db')" -ForegroundColor Red
  Write-Host "可先跑一次 Sub获客脚本，或把 -DbDir 指到实际目录。"
  exit 1
}

$compose = Join-Path $PSScriptRoot "docker-compose.db-ui.yml"
$env:SUB_GUEST_DIR = ($DbDir -replace '\\', '/')

Write-Host "DB 目录: $DbDir"
Write-Host "启动 sqlite-web -> http://127.0.0.1:$Port"
Write-Host "停止: docker compose -f `"$compose`" down"

docker compose -f $compose up -d --force-recreate
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Start-Sleep -Seconds 1
Start-Process "http://127.0.0.1:$Port"
Write-Host "OK"
