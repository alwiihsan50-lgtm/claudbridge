$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServerDir = Join-Path $ProjectRoot "server"
$AgentDir = Join-Path $ProjectRoot "windows_agent"
$LogsDir = Join-Path $ProjectRoot "logs"
$TokenPath = Join-Path $ProjectRoot ".local-token.txt"
$UrlPath = Join-Path $ProjectRoot "current-public-url.txt"

New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null

if (!(Test-Path $TokenPath)) {
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($bytes)
  $rng.Dispose()
  $token = [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
  Set-Content -LiteralPath $TokenPath -Value $token -NoNewline -Encoding UTF8
} else {
  $token = (Get-Content -LiteralPath $TokenPath -Raw).Trim()
}

Get-CimInstance Win32_Process |
  Where-Object {
    $_.CommandLine -like "*$ProjectRoot*" -and
    ($_.CommandLine -like "*uvicorn*" -or $_.CommandLine -like "*cloudflared tunnel*" -or $_.CommandLine -like "*agent.py*")
  } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Remove-Item -LiteralPath `
  (Join-Path $LogsDir "server.out.log"),
  (Join-Path $LogsDir "server.err.log"),
  (Join-Path $LogsDir "agent.out.log"),
  (Join-Path $LogsDir "agent.err.log"),
  (Join-Path $LogsDir "cloudflared.out.log"),
  (Join-Path $LogsDir "cloudflared.err.log") -Force -ErrorAction SilentlyContinue

$serverCmd = "`$env:CLOUD_BRIDGE_TOKEN='$token'; cd '$ServerDir'; .\.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000"
Start-Process -FilePath powershell.exe -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $serverCmd) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $LogsDir "server.out.log") -RedirectStandardError (Join-Path $LogsDir "server.err.log")

Start-Sleep -Seconds 3

$agentCmd = "cd '$AgentDir'; .\.venv\Scripts\python.exe agent.py"
Start-Process -FilePath powershell.exe -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $agentCmd) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $LogsDir "agent.out.log") -RedirectStandardError (Join-Path $LogsDir "agent.err.log")

Start-Process -FilePath cloudflared.exe -ArgumentList @("tunnel", "--url", "http://127.0.0.1:8000", "--no-autoupdate") -WindowStyle Hidden -RedirectStandardOutput (Join-Path $LogsDir "cloudflared.out.log") -RedirectStandardError (Join-Path $LogsDir "cloudflared.err.log")

$publicUrl = $null
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  $matches = Select-String -Path (Join-Path $LogsDir "cloudflared.err.log") -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" -AllMatches -ErrorAction SilentlyContinue
  if ($matches) {
    $publicUrl = $matches.Matches[0].Value
    break
  }
}

if ($publicUrl) {
  Set-Content -LiteralPath $UrlPath -Value $publicUrl -Encoding UTF8
  Write-Output "CloudBridge running: $publicUrl"
} else {
  Write-Output "CloudBridge running locally, but public URL was not found yet. Check logs\cloudflared.err.log."
}

