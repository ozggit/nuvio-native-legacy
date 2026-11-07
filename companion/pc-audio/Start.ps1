$ErrorActionPreference = 'Stop'
$appDir = $PSScriptRoot
$nodePath = (Get-Command node -ErrorAction Stop).Source
$dataDir = Join-Path $appDir 'data'
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
$alreadyRunning = $false
try { $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/health' -TimeoutSec 2; $alreadyRunning = $health.name -eq 'Nuvio PC Audio' } catch {}
if (-not $alreadyRunning) {
    $serverPath = Join-Path $appDir 'server.mjs'
    $process = Start-Process -FilePath $nodePath -ArgumentList @('"' + $serverPath + '"') -WorkingDirectory $appDir -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $dataDir 'server.log') -RedirectStandardError (Join-Path $dataDir 'server-error.log')
    $process.Id | Set-Content -LiteralPath (Join-Path $dataDir 'server.pid')
    Start-Sleep -Seconds 2
}
Start-Process 'http://127.0.0.1:8788'
