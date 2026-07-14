$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

Get-CimInstance Win32_Process |
  Where-Object {
    $_.CommandLine -like "*$ProjectRoot*" -and
    ($_.CommandLine -like "*agent.py*" -or $_.CommandLine -like "*tray_agent.py*")
  } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Write-Output "CloudBridge Windows Agent stopped."

