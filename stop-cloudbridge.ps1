$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

Get-CimInstance Win32_Process |
  Where-Object {
    $_.CommandLine -like "*$ProjectRoot*" -and
    ($_.CommandLine -like "*uvicorn*" -or $_.CommandLine -like "*cloudflared tunnel*" -or $_.CommandLine -like "*agent.py*")
  } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Write-Output "CloudBridge stopped."

