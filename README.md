# Cloud Clipboard & File Bridge

CloudBridge menyinkronkan clipboard teks dan file dua arah antara iPhone dan Windows 11 lewat internet. Versi utama sekarang berjalan penuh di Supabase, tanpa Render, tunnel, atau URL sementara.

URL API stabil:

```text
https://ajlkfzgpheegmwsnspxw.supabase.co/functions/v1/cloudbridge
```

URL app iPhone:

```text
https://alwiihsan50-lgtm.github.io/cloud-clipboard-file-bridge/app/
```

## Komponen

- `supabase/functions/cloudbridge/` - backend API sebagai Supabase Edge Function.
- `docs/app/` - PWA iPhone yang disajikan lewat GitHub Pages.
- `windows_agent/` - agent Windows Python untuk membaca clipboard lokal, mengambil update cloud, mengunduh file, dan memberi notifikasi.
- `server/migrations/` - SQL setup tabel, bucket, dan token admin CloudBridge.
- `server/` - backend FastAPI lama untuk referensi lokal/legacy, bukan jalur utama.

## Realtime

CloudBridge memakai Supabase Realtime Broadcast untuk sinyal kecil:

- `clipboard`: ada clipboard baru di cloud.
- `file`: ada file baru di cloud.

Payload Realtime tidak berisi isi clipboard atau binary file. Setelah menerima sinyal, Windows Agent tetap mengambil data lewat API bertoken. Polling cloud tetap ada sebagai fallback lambat setiap 5 menit.

## Jalur Utama: Supabase Edge Function

Backend utama ada di project Supabase `riwayat smart relay` dengan ref `ajlkfzgpheegmwsnspxw`.

Endpoint API yang tersedia di Supabase:

```text
GET  /health
GET  /api/me
POST /api/pairing/create
POST /api/pairing/claim
POST /api/clipboard/push
GET  /api/clipboard/latest
GET  /api/clipboard/history
POST /api/clipboard/{id}/pin
POST /api/clipboard/{id}/unpin
POST /api/files/upload
GET  /api/files/pending
GET  /api/files/history
GET  /api/files/{id}/download
POST /api/files/{id}/ack
POST /api/files/{id}/pin
POST /api/files/{id}/unpin
POST /api/quick-actions/setup
DELETE /api/quick-actions/setup
POST /api/quick/clipboard/push
GET  /api/quick/clipboard/pull
POST /api/cleanup
```

Endpoint publik hanya `/health` dan `/api/pairing/claim`. Endpoint lain memakai:

```http
Authorization: Bearer <token>
```

Token admin disimpan sebagai hash SHA-256 di tabel `cloudbridge_admin_tokens` dan hanya dipakai Windows Agent/tray untuk membuat pairing code. Token device iPhone dan PC Web Manager disimpan sebagai hash SHA-256 di tabel `cloudbridge_devices`.

Token Quick Actions memakai scope `clipboard_quick`. Token ini hanya dapat push/pull clipboard dan tidak dapat membuka file, history, pairing, atau cleanup.

## Menjalankan di Windows Ini

File konfigurasi agent ada di `windows_agent/.env` dan sudah diarahkan ke URL Supabase stabil.

Jalankan agent:

```powershell
.\start-windows-agent.ps1
```

Stop agent:

```powershell
.\stop-windows-agent.ps1
```

Folder penerimaan file:

```text
D:\Cloud Bridge
```

Windows Agent membuka koneksi Supabase Realtime supaya update dari iPhone terasa instan. Polling cloud fallback default adalah `300000ms` atau 5 menit.

Untuk mengirim file dari Windows ke iPhone, gunakan menu tray `Send file to iPhone`, lalu buka tab `Files` di PWA iPhone dan tekan `Open`.

Menu tray `Open CloudBridge Manager` membuat pairing code singkat dan otomatis mendaftarkan browser PC sebagai device `windows-web`. Admin token tidak dikirim ke browser.

## Pairing iPhone

1. Jalankan Windows Agent.
2. Dari tray CloudBridge, pilih menu untuk membuat pairing link.
3. Buka link `https://alwiihsan50-lgtm.github.io/cloud-clipboard-file-bridge/app/?code=...` di iPhone.
4. Tap `Pair iPhone`.
5. Di Safari iPhone, gunakan `Add to Home Screen` supaya CloudBridge tampil seperti app.

## Quick Actions iPhone

PWA Manager menyediakan menu ikon petir `Quick Actions`. Pilih `Create setup key`, lalu ikuti dua resep yang ditampilkan untuk membuat:

- `CloudBridge Push` - satu tap mengirim clipboard iPhone ke Windows.
- `CloudBridge Pull` - satu tap mengambil teks terbaru dari device lain ke clipboard iPhone.
- `CloudBridge` - ikon PWA utama untuk membuka manager.

Untuk Push, ubah hasil `Get Clipboard` menjadi teks terlebih dahulu. Gunakan
`Get Contents of URL` dengan metode `POST`, request body `File`, lalu pilih hasil
`Get Text from Clipboard`. Endpoint juga tetap menerima JSON dengan field
`content`.

Tambahkan kedua shortcut ke Home Screen dari aplikasi Shortcuts. Membuat key baru otomatis mengganti key Quick Actions lama. Gunakan `Revoke key` untuk menonaktifkan kedua shortcut tanpa memutus pairing PWA.

## Data dan Konflik

- Clipboard menyimpan `id`, `content`, `source`, `version`, `created_at`, dan `device_id`.
- Server memakai aturan `last-write-wins` berdasarkan urutan `version` dari database.
- Windows Agent mengirim `device_id`; endpoint latest tidak mengirim echo balik ke device pengirim.
- File masuk ke bucket private `cloudbridge-files`.
- Clipboard dan file punya status `pinned`; item pinned tidak ikut cleanup otomatis.
- Setelah Windows mengirim `ack`, file ditandai `downloaded`, tetapi object storage tidak langsung dihapus.
- Cleanup otomatis berjalan oportunistik maksimal 1x per 24 jam setelah operasi tulis penting.
- Clipboard unpinned disimpan 7 hari.
- File unpinned bersifat transfer sementara dan dibersihkan setelah retention serta grace period berakhir.
- File pinned tetap disimpan sampai user melakukan unpin.

## CloudBridge Manager

PWA memiliki workspace clipboard dan file yang sama di iPhone maupun PC. Clipboard dibagi menjadi `Pinned` dan `Recent`; Files dibagi menjadi `Pinned` dan `Temporary`. File hanya memiliki aksi Open, Pin, dan Unpin. Unpin memakai konfirmasi karena file dapat masuk cleanup otomatis.

PWA menampilkan UI langsung dari token lokal dan memvalidasi pairing di background. Daftar Files dimuat 50 item per halaman dengan cursor pagination tanpa cache workspace berat.

Di Windows tray, menu `Open CloudBridge Manager` membuka PWA manager:

```text
https://alwiihsan50-lgtm.github.io/cloud-clipboard-file-bridge/app/
```

## Catatan PWA

Supabase Edge Functions tidak dipakai untuk halaman PWA karena response HTML dari Edge Function dikirim sebagai `text/plain`. Karena itu app iPhone disajikan dari GitHub Pages, sementara semua operasi data tetap lewat Supabase API.

## Legacy Lokal

Folder `server/` dan test FastAPI lama masih dipertahankan sebagai referensi development. Jalur produksi/pribadi sekarang adalah Supabase Edge Function, jadi tidak perlu Render, Railway, Fly.io, Cloudflare tunnel, atau URL yang berubah saat restart.
