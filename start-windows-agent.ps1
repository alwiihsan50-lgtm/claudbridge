$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$AgentDir = Join-Path $ProjectRoot "windows_agent"
$LogsDir = Join-Path $ProjectRoot "logs"

New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null

Get-CimInstance Win32_Process |
  Where-Object {
    $_.CommandLine -like "*$ProjectRoot*" -and
    ($_.CommandLine -like "*agent.py*" -or $_.CommandLine -like "*tray_agent.py*")
  } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

$agentCmd = "cd '$AgentDir'; .\.venv\Scripts\python.exe tray_agent.py"
Start-Process -FilePath powershell.exe -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $agentCmd) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $LogsDir "agent.out.log") -RedirectStandardError (Join-Path $LogsDir "agent.err.log")

Write-Output "CloudBridge Windows Agent started."

