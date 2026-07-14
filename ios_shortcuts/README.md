# iOS Shortcuts Setup

V1 memakai iOS Shortcuts karena iOS tidak mengizinkan utility clipboard berjalan bebas 24 jam di background.

Ganti nilai berikut di semua Shortcut:

- `BASE_URL`: URL server, contoh `https://cloud-clipboard-file-bridge.onrender.com`
- `TOKEN`: token rahasia yang sama dengan `CLOUD_BRIDGE_TOKEN`
- `DEVICE_ID`: contoh `iphone-alwi`

## Shortcut 1: Push Clipboard to PC

Tujuan: ambil clipboard iPhone dan kirim ke cloud agar Windows Agent mengambilnya.

Langkah:

1. Add Action: `Get Clipboard`.
2. Add Action: `Text`, isi JSON berikut:

```json
{
  "content": "CLIPBOARD_VALUE",
  "source": "ios",
  "device_id": "DEVICE_ID"
}
```

3. Pada field `content`, ganti `CLIPBOARD_VALUE` dengan variable hasil `Get Clipboard`.
4. Add Action: `Get Contents of URL`.
5. URL: `BASE_URL/api/clipboard/push`.
6. Method: `POST`.
7. Headers:
   - `Authorization`: `Bearer TOKEN`
   - `Content-Type`: `application/json`
8. Request Body: `File`, pilih hasil action `Text` JSON.
9. Opsional: Add Action `Show Notification` dengan teks `Clipboard sent to PC`.

## Shortcut 2: Pull Clipboard from PC

Tujuan: ambil clipboard terbaru dari cloud dan set ke clipboard iPhone.

Langkah:

1. Add Action: `Get Contents of URL`.
2. URL: `BASE_URL/api/clipboard/latest?device_id=DEVICE_ID`.
3. Method: `GET`.
4. Headers:
   - `Authorization`: `Bearer TOKEN`
5. Add Action: `Get Dictionary from Input`.
6. Ambil value `has_update`.
7. If `has_update` is true:
   - Ambil dictionary `item`.
   - Ambil value `content`.
   - Add Action: `Copy to Clipboard`.
   - Add Action: `Show Notification` dengan teks `Clipboard ready to paste`.
8. Otherwise:
   - Add Action: `Show Notification` dengan teks `No new clipboard`.

## Shortcut 3: Send File to PC

Tujuan: muncul di Share Sheet iOS untuk upload file/foto ke cloud agar Windows Agent mendownloadnya.

Shortcut settings:

- Enable `Use as Quick Action`.
- Enable `Share Sheet`.
- Accepted input: `Files`, `Images`, `Media`.

Langkah:

1. Add Action: `Get Contents of URL`.
2. URL: `BASE_URL/api/files/upload`.
3. Method: `POST`.
4. Headers:
   - `Authorization`: `Bearer TOKEN`
5. Request Body: `Form`.
6. Form fields:
   - `file`: type `File`, value `Shortcut Input`.
   - `source`: type `Text`, value `ios`
   - `device_id`: type `Text`, value `DEVICE_ID`
7. Add Action: `Show Notification` dengan teks `File sent to PC`.

## Back Tap

Untuk trigger cepat:

1. Buka iPhone `Settings`.
2. `Accessibility`.
3. `Touch`.
4. `Back Tap`.
5. Pilih `Double Tap` atau `Triple Tap`.
6. Pilih Shortcut `Push Clipboard to PC` atau `Pull Clipboard from PC`.

