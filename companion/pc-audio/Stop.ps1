$pidFile = Join-Path $PSScriptRoot 'data\server.pid'
if (Test-Path -LiteralPath $pidFile) {
    $serverPid = [int](Get-Content -LiteralPath $pidFile)
    $serverProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$serverPid"
    $serverPath = Join-Path $PSScriptRoot 'server.mjs'
    if ($serverProcess -and $serverProcess.Name -eq 'node.exe' -and $serverProcess.CommandLine.Contains($serverPath)) {
        Get-CimInstance Win32_Process -Filter "ParentProcessId=$serverPid" | Where-Object { $_.Name -in @('ffmpeg.exe','ffprobe.exe') } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
        Stop-Process -Id $serverPid -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $pidFile
}
