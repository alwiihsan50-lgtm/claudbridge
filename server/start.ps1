$env:CLOUD_BRIDGE_TOKEN = if ($env:CLOUD_BRIDGE_TOKEN) { $env:CLOUD_BRIDGE_TOKEN } else { "change-me" }
uvicorn main:app --host 0.0.0.0 --port 8000

