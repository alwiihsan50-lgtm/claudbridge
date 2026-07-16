# API Contract

Base URL:

```text
https://ajlkfzgpheegmwsnspxw.supabase.co/functions/v1/cloudbridge
```

Protected endpoints require either the admin token or a paired device token:

```http
Authorization: Bearer <CLOUD_BRIDGE_TOKEN>
```

## Realtime Broadcast

Realtime channel:

```text
cloudbridge
```

Event:

```text
cloudbridge_change
```

Payload examples:

```json
{
  "kind": "clipboard",
  "id": "uuid",
  "version": 14,
  "source": "ios-pwa",
  "device_id": "ios-device-id"
}
```

```json
{
  "kind": "file",
  "id": "uuid",
  "filename": "photo.jpg",
  "source": "ios-pwa",
  "device_id": "ios-device-id"
}
```

Realtime payloads are signals only. Clipboard content and file payloads are fetched through the protected API.

## `GET /health`

Public health check.

Response:

```json
{
  "ok": true,
  "service": "CloudBridge",
  "mode": "supabase-edge"
}
```

## `POST /api/pairing/create`

Admin-only endpoint used by Windows tray app to create a short-lived pairing link.

Request:

```json
{
  "device_id": "windows-main",
  "label": "Windows PC"
}
```

Response:

```json
{
  "ok": true,
  "code": "short-lived-secret",
  "pairing_url": "https://ajlkfzgpheegmwsnspxw.supabase.co/functions/v1/cloudbridge/app?code=short-lived-secret",
  "expires_at": "2026-07-14T03:10:00+00:00"
}
```

The Windows tray app uses `code` to build the iPhone app URL:

```text
https://alwiihsan50-lgtm.github.io/cloud-clipboard-file-bridge/app/?code=short-lived-secret
```

## `POST /api/pairing/claim`

Public endpoint used by the iPhone PWA to exchange a pairing code for a device token.

Request:

```json
{
  "code": "short-lived-secret",
  "device_id": "ios-device-id",
  "label": "iPhone",
  "platform": "ios"
}
```

Response:

```json
{
  "ok": true,
  "device_id": "ios-device-id",
  "token": "device-token"
}
```

`platform` is optional. The iPhone PWA sends `ios`; the Windows tray auto-manager flow sends `windows-web`. The returned token is only shown once to the client; the database stores its SHA-256 hash in `cloudbridge_devices`.

## `GET /api/me`

Validates the current admin/device token.

## `POST /api/clipboard/push`

Push latest clipboard text.

Request:

```json
{
  "content": "text to sync",
  "source": "ios",
  "device_id": "iphone-alwi"
}
```

Response:

```json
{
  "ok": true,
  "item": {
    "id": "uuid",
    "content": "text to sync",
    "source": "ios",
    "version": 1,
    "created_at": "2026-07-14T03:00:00+00:00",
    "device_id": "iphone-alwi",
    "pinned": false,
    "pinned_at": null,
    "pinned_by_device_id": null
  }
}
```

## `GET /api/clipboard/latest`

Query params:

- `device_id`: current device id; prevents echoing its own clipboard.
- `since_id`: last seen clipboard record id.

Response with update:

```json
{
  "ok": true,
  "has_update": true,
  "item": {
    "id": "uuid",
    "content": "latest text",
    "source": "windows",
    "version": 2,
    "created_at": "2026-07-14T03:01:00+00:00",
    "device_id": "windows-pc"
  }
}
```

Response without update:

```json
{
  "ok": true,
  "has_update": false,
  "item": null
}
```

## `GET /api/clipboard/history`

Returns recent clipboard records for the manager UI.

Query params:

- `limit`: optional, default `50`, max `100`.

Response:

```json
{
  "ok": true,
  "items": [
    {
      "id": "uuid",
      "content": "latest text",
      "source": "windows",
      "device_id": "windows-pc",
      "version": 12,
      "created_at": "2026-07-14T03:01:00+00:00",
      "pinned": false,
      "pinned_at": null,
      "pinned_by_device_id": null
    }
  ]
}
```

## `POST /api/clipboard/{id}/pin`

Marks a clipboard record as pinned so automatic cleanup will not delete it.

## `POST /api/clipboard/{id}/unpin`

Removes the pinned status from a clipboard record.

## `POST /api/files/upload`

Multipart form request:

- `file`: uploaded file.
- `source`: `ios-pwa` or `windows-tray`.
- `device_id`: sender device id.

Response:

```json
{
  "ok": true,
  "item": {
    "id": "uuid",
    "filename": "photo.jpg",
    "size": 12345,
    "mime_type": "image/jpeg",
    "source": "ios",
    "device_id": "iphone-alwi",
    "uploaded_at": "2026-07-14T03:02:00+00:00",
    "status": "pending",
    "downloaded_at": null,
    "pinned": false,
    "pinned_at": null,
    "pinned_by_device_id": null
  }
}
```

## `GET /api/files/pending`

Query params:

- `device_id`: current device id; excludes files uploaded by the same device.

Response:

```json
{
  "ok": true,
  "items": []
}
```

## `GET /api/files/{id}/download`

Returns the file binary with inline content disposition. The iPhone PWA uses the authenticated response to open files uploaded from Windows, while the Windows Agent can still save the same response to disk.

## `POST /api/files/{id}/ack`

Marks a file as downloaded. The stored file payload is not deleted immediately; cleanup deletes unpinned downloaded files after the configured grace period.

Response:

```json
{
  "ok": true,
  "item": {
    "id": "uuid",
    "filename": "photo.jpg",
    "size": 12345,
    "mime_type": "image/jpeg",
    "source": "ios",
    "device_id": "iphone-alwi",
    "uploaded_at": "2026-07-14T03:02:00+00:00",
    "status": "downloaded",
    "downloaded_at": "2026-07-14T03:03:00+00:00",
    "pinned": false,
    "pinned_at": null,
    "pinned_by_device_id": null
  }
}
```

## `GET /api/files/history`

Returns recent file records for the manager UI. The response does not expose `storage_path`.

Query params:

- `limit`: optional, default `50`, max `100`.
- `pinned`: optional `true` or `false` filter.
- `before_uploaded_at`: optional ISO timestamp cursor returned as `next_cursor`.

## `POST /api/files/{id}/pin`

Marks a file as pinned so automatic cleanup will not delete the row or storage object.

## `POST /api/files/{id}/unpin`

Removes the pinned status from a file.

## Quick Actions

### `POST /api/quick-actions/setup`

Requires a full device token. Creates or rotates one child token with scope `clipboard_quick`. The plaintext token is returned once with `push_url` and `pull_url`.

### `DELETE /api/quick-actions/setup`

Requires the parent full device token and revokes its Quick Actions token.

### `POST /api/quick/clipboard/push`

Requires a `clipboard_quick` token. Accepts a raw text/File body from iOS Shortcuts or JSON `{ "content": "text" }`. Empty content is rejected and the maximum UTF-8 payload is 1 MB. The server records source `ios-shortcut` and broadcasts a Realtime clipboard signal.

### `GET /api/quick/clipboard/pull`

Requires a `clipboard_quick` token. Returns the latest clipboard content from another device as `text/plain`, or HTTP `204` when none exists.

Quick tokens may call only these clipboard endpoints and `/api/me`. Every other protected endpoint returns `403`.

## `POST /api/cleanup`

Admin-only manual cleanup endpoint.

Cleanup policy:

- Deletes unpinned clipboard records older than 7 days.
- Deletes all unpinned files after the temporary transfer retention window.
- Deletes file objects from `cloudbridge-files` before deleting file rows.
- Never deletes pinned clipboard or pinned files.

## Conflict Rules

- Clipboard uses last-write-wins based on server write order.
- `version` increments on every clipboard push.
- Clients should pass `device_id` and `since_id` to avoid receiving stale records or their own writes.
- File records are independent and do not conflict; every upload creates a new pending item.
