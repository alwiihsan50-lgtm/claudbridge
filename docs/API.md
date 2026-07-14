# API Contract

Protected endpoints require either the admin token or a paired device token:

```http
Authorization: Bearer <CLOUD_BRIDGE_TOKEN>
```

## `GET /health`

Public health check.

Response:

```json
{
  "ok": "true",
  "service": "Cloud Clipboard & File Bridge"
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
  "pairing_url": "https://app.onrender.com/app?code=short-lived-secret",
  "expires_at": "2026-07-14T03:10:00+00:00"
}
```

## `POST /api/pairing/claim`

Public endpoint used by the iPhone PWA to exchange a pairing code for a device token.

Request:

```json
{
  "code": "short-lived-secret",
  "device_id": "ios-device-id",
  "label": "iPhone"
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
    "device_id": "iphone-alwi"
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

## `POST /api/files/upload`

Multipart form request:

- `file`: uploaded file.
- `source`: `ios`.
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
    "downloaded_at": null
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

Downloads the file binary.

## `POST /api/files/{id}/ack`

Marks a file as downloaded. By default the server deletes the stored file payload after ack.

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
    "downloaded_at": "2026-07-14T03:03:00+00:00"
  }
}
```

## Conflict Rules

- Clipboard uses last-write-wins based on server write order.
- `version` increments on every clipboard push.
- Clients should pass `device_id` and `since_id` to avoid receiving stale records or their own writes.
- File records are independent and do not conflict; every upload creates a new pending item.
