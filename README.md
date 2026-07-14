# Cloud Clipboard & File Bridge

App self-hosted untuk sinkronisasi clipboard teks dan transfer file dari iPhone ke Windows 11 lewat internet.

## Komponen

- `server/` - Cloud Bridge API berbasis FastAPI.
- `windows_agent/` - Agent Windows Python untuk polling clipboard, polling cloud, download file, dan notifikasi.
- `ios_shortcuts/` - Panduan opsional membuat tiga iOS Shortcuts: Push Clipboard, Pull Clipboard, dan Send File to PC.
- `server/migrations/` - SQL setup Supabase untuk mode cloud permanen.
- `tests/` - Test kontrak API server.

## Mode Matang: Render + Supabase

Gunakan mode ini supaya URL tidak berubah setelah restart.

1. Buat project Supabase khusus CloudBridge.
2. Jalankan SQL di [server/migrations/001_cloudbridge_supabase.sql](server/migrations/001_cloudbridge_supabase.sql).
3. Deploy folder `server/` ke Render.
4. Isi environment variable Render:

```env
CLOUD_BRIDGE_TOKEN=<random-admin-token>
CLOUD_BRIDGE_PUBLIC_URL=https://<nama-app>.onrender.com
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
SUPABASE_STORAGE_BUCKET=cloudbridge-files
```

5. Di Windows, isi `windows_agent/.env`:

```env
CLOUD_BRIDGE_BASE_URL=https://<nama-app>.onrender.com
CLOUD_BRIDGE_TOKEN=<random-admin-token>
CLOUD_BRIDGE_DEVICE_ID=windows-main
POLL_INTERVAL_MS=1500
DOWNLOAD_DIR=C:\Users\alwii\Downloads\CloudBridge
```

6. Jalankan `start-windows-agent.ps1`.
7. Dari tray CloudBridge, pilih `Show pairing link`; buka link itu di iPhone dan tap `Pair iPhone`.
8. Di iPhone Safari, tap Share, lalu `Add to Home Screen`.

## Alur Cepat Lokal

1. Jalankan server:

```powershell
cd server
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:CLOUD_BRIDGE_TOKEN="change-me"
uvicorn main:app --host 0.0.0.0 --port 8000
```

2. Jalankan agent Windows di terminal lain:

```powershell
cd windows_agent
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
notepad .env
python agent.py
```

Isi `.env` minimal:

```env
CLOUD_BRIDGE_BASE_URL=http://127.0.0.1:8000
CLOUD_BRIDGE_TOKEN=change-me
```

3. Untuk pemakaian internet permanen, gunakan mode Render + Supabase di atas.

## Keamanan

Semua endpoint API selain `/health` membutuhkan:

```http
Authorization: Bearer <CLOUD_BRIDGE_TOKEN>
```

Gunakan HTTPS pada deployment publik. Token v1 bersifat static secret tunggal, cocok untuk utilitas pribadi.

## Batasan

- iOS default memakai PWA Home Screen, bukan native app background.
- iOS Shortcuts tetap opsional untuk aksi clipboard lebih cepat.
- Mode lokal-memory tetap tersedia untuk development, tetapi mode matang memakai Supabase.
- Konflik clipboard memakai aturan last-write-wins berdasarkan timestamp server.

