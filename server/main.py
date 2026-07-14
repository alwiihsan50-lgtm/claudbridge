from __future__ import annotations

import hashlib
import os
import secrets
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse
from pydantic import BaseModel, Field

try:
    from supabase import Client, create_client
except Exception:  # pragma: no cover - optional when running in local-memory mode
    Client = None
    create_client = None


APP_NAME = "Cloud Clipboard & File Bridge"
TOKEN = os.getenv("CLOUD_BRIDGE_TOKEN", "change-me")
PUBLIC_BASE_URL = os.getenv("CLOUD_BRIDGE_PUBLIC_URL", "").rstrip("/")
UPLOAD_DIR = Path(os.getenv("CLOUD_BRIDGE_UPLOAD_DIR", "uploads")).resolve()
DELETE_AFTER_ACK = os.getenv("CLOUD_BRIDGE_DELETE_AFTER_ACK", "true").lower() == "true"
FILE_TTL_SECONDS = int(os.getenv("CLOUD_BRIDGE_FILE_TTL_SECONDS", str(24 * 60 * 60)))
PAIRING_TTL_SECONDS = int(os.getenv("CLOUD_BRIDGE_PAIRING_TTL_SECONDS", "600"))
SUPABASE_BUCKET = os.getenv("SUPABASE_STORAGE_BUCKET", "cloudbridge-files")
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title=APP_NAME, version="0.2.0")

clipboard_state: dict[str, Any] | None = None
clipboard_version = 0
file_records: dict[str, dict[str, Any]] = {}
pairing_records: dict[str, dict[str, Any]] = {}
device_records: dict[str, dict[str, Any]] = {}


def now_dt() -> datetime:
    return datetime.now(timezone.utc)


def now_iso() -> str:
    return now_dt().isoformat()


def parse_dt(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def hash_secret(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def safe_filename(name: str) -> str:
    cleaned = Path(name).name.strip().replace("\x00", "")
    return cleaned or "upload.bin"


def public_base_url() -> str:
    return PUBLIC_BASE_URL or ""


def supabase_client() -> Client | None:
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY or create_client is None:
        return None
    return create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)


SB = supabase_client()


class AuthContext(BaseModel):
    kind: str
    token: str
    device_id: str | None = None


class ClipboardPushRequest(BaseModel):
    content: str = Field(min_length=1, max_length=500_000)
    source: str = Field(default="unknown", max_length=32)
    device_id: str = Field(min_length=1, max_length=128)


class PairingCreateRequest(BaseModel):
    device_id: str = Field(min_length=1, max_length=128)
    label: str = Field(default="Windows PC", max_length=80)


class PairingClaimRequest(BaseModel):
    code: str = Field(min_length=6, max_length=64)
    device_id: str = Field(min_length=1, max_length=128)
    label: str = Field(default="iPhone", max_length=80)


def bearer_token(authorization: str | None) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Invalid or missing bearer token")
    return authorization.removeprefix("Bearer ").strip()


def lookup_device_by_token(token: str) -> dict[str, Any] | None:
    token_hash = hash_secret(token)
    if SB is not None:
        data = (
            SB.table("cloudbridge_devices")
            .select("*")
            .eq("token_hash", token_hash)
            .eq("revoked", False)
            .limit(1)
            .execute()
            .data
        )
        return data[0] if data else None
    return device_records.get(token_hash)


def require_any_auth(authorization: str | None = Header(default=None)) -> AuthContext:
    token = bearer_token(authorization)
    if secrets.compare_digest(token, TOKEN):
        return AuthContext(kind="admin", token=token)

    device = lookup_device_by_token(token)
    if device:
        return AuthContext(kind="device", token=token, device_id=device["device_id"])

    raise HTTPException(status_code=401, detail="Invalid token")


def require_admin_auth(authorization: str | None = Header(default=None)) -> AuthContext:
    token = bearer_token(authorization)
    if not secrets.compare_digest(token, TOKEN):
        raise HTTPException(status_code=401, detail="Admin token required")
    return AuthContext(kind="admin", token=token)


def public_file_record(record: dict[str, Any]) -> dict[str, Any]:
    hidden = {"stored_name", "storage_path"}
    return {k: v for k, v in record.items() if k not in hidden}


def insert_clipboard_record(payload: ClipboardPushRequest) -> dict[str, Any]:
    global clipboard_state, clipboard_version

    if SB is not None:
        row = {
            "content": payload.content,
            "source": payload.source,
            "device_id": payload.device_id,
        }
        return SB.table("cloudbridge_clipboard").insert(row).execute().data[0]

    clipboard_version += 1
    record = {
        "id": str(uuid.uuid4()),
        "content": payload.content,
        "source": payload.source,
        "version": clipboard_version,
        "created_at": now_iso(),
        "device_id": payload.device_id,
    }
    clipboard_state = record
    return record


def get_latest_clipboard() -> dict[str, Any] | None:
    if SB is not None:
        data = (
            SB.table("cloudbridge_clipboard")
            .select("*")
            .order("version", desc=True)
            .limit(1)
            .execute()
            .data
        )
        return data[0] if data else None
    return clipboard_state


def upload_payload_to_storage(file_id: str, filename: str, body: bytes, mime_type: str) -> str:
    storage_path = f"{file_id}/{filename}"
    if SB is not None:
        SB.storage.from_(SUPABASE_BUCKET).upload(
            storage_path,
            body,
            {"content-type": mime_type, "upsert": "false"},
        )
        return storage_path

    stored_name = f"{file_id}-{filename}"
    stored_path = UPLOAD_DIR / stored_name
    stored_path.write_bytes(body)
    return stored_name


def download_payload(record: dict[str, Any]) -> bytes:
    if SB is not None:
        return SB.storage.from_(SUPABASE_BUCKET).download(record["storage_path"])

    stored_path = UPLOAD_DIR / record["stored_name"]
    if not stored_path.exists():
        raise HTTPException(status_code=410, detail="File payload expired")
    return stored_path.read_bytes()


def delete_payload(record: dict[str, Any]) -> None:
    if SB is not None:
        if record.get("storage_path"):
            SB.storage.from_(SUPABASE_BUCKET).remove([record["storage_path"]])
        return

    stored_path = UPLOAD_DIR / record["stored_name"]
    if stored_path.exists():
        stored_path.unlink()


def insert_file_record(record: dict[str, Any]) -> dict[str, Any]:
    if SB is not None:
        row = {
            "id": record["id"],
            "filename": record["filename"],
            "storage_path": record["storage_path"],
            "size": record["size"],
            "mime_type": record["mime_type"],
            "source": record["source"],
            "device_id": record["device_id"],
            "status": "pending",
            "expires_at": (now_dt() + timedelta(seconds=FILE_TTL_SECONDS)).isoformat(),
        }
        return SB.table("cloudbridge_files").insert(row).execute().data[0]

    file_records[record["id"]] = record
    return record


def get_file_record(file_id: str) -> dict[str, Any] | None:
    if SB is not None:
        data = SB.table("cloudbridge_files").select("*").eq("id", file_id).limit(1).execute().data
        return data[0] if data else None
    return file_records.get(file_id)


def list_pending_files(device_id: str | None) -> list[dict[str, Any]]:
    if SB is not None:
        query = (
            SB.table("cloudbridge_files")
            .select("*")
            .eq("status", "pending")
            .gt("expires_at", now_iso())
            .order("uploaded_at")
        )
        if device_id:
            query = query.neq("device_id", device_id)
        return query.execute().data

    items = []
    for record in file_records.values():
        if record["status"] != "pending":
            continue
        if record.get("expires_at") and parse_dt(record["expires_at"]) <= now_dt():
            continue
        if device_id and record["device_id"] == device_id:
            continue
        items.append(record)
    items.sort(key=lambda item: item["uploaded_at"])
    return items


def create_pairing_record(payload: PairingCreateRequest) -> dict[str, Any]:
    code = secrets.token_urlsafe(18)
    expires_at = (now_dt() + timedelta(seconds=PAIRING_TTL_SECONDS)).isoformat()
    record = {
        "id": str(uuid.uuid4()),
        "code_hash": hash_secret(code),
        "code": code,
        "created_by_device_id": payload.device_id,
        "created_by_label": payload.label,
        "claimed_by_device_id": None,
        "expires_at": expires_at,
        "claimed_at": None,
    }
    if SB is not None:
        row = {k: v for k, v in record.items() if k != "code"}
        saved = SB.table("cloudbridge_pairing_sessions").insert(row).execute().data[0]
        saved["code"] = code
        return saved

    pairing_records[record["code_hash"]] = record
    return record


def claim_pairing(payload: PairingClaimRequest) -> dict[str, Any]:
    code_hash = hash_secret(payload.code)
    token = secrets.token_urlsafe(32)
    token_hash = hash_secret(token)

    if SB is not None:
        sessions = (
            SB.table("cloudbridge_pairing_sessions")
            .select("*")
            .eq("code_hash", code_hash)
            .is_("claimed_at", "null")
            .gt("expires_at", now_iso())
            .limit(1)
            .execute()
            .data
        )
        if not sessions:
            raise HTTPException(status_code=404, detail="Pairing code is invalid or expired")

        session = sessions[0]
        device = {
            "device_id": payload.device_id,
            "label": payload.label,
            "platform": "ios",
            "token_hash": token_hash,
        }
        SB.table("cloudbridge_devices").upsert(device, on_conflict="device_id").execute()
        SB.table("cloudbridge_pairing_sessions").update(
            {"claimed_by_device_id": payload.device_id, "claimed_at": now_iso()}
        ).eq("id", session["id"]).execute()
        return {"device_id": payload.device_id, "token": token}

    session = pairing_records.get(code_hash)
    if not session or session.get("claimed_at") or parse_dt(session["expires_at"]) <= now_dt():
        raise HTTPException(status_code=404, detail="Pairing code is invalid or expired")

    session["claimed_by_device_id"] = payload.device_id
    session["claimed_at"] = now_iso()
    device_records[token_hash] = {
        "device_id": payload.device_id,
        "label": payload.label,
        "platform": "ios",
        "token_hash": token_hash,
        "revoked": False,
        "created_at": now_iso(),
    }
    return {"device_id": payload.device_id, "token": token}


PWA_HTML = """
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#101820">
  <link rel="manifest" href="/manifest.json">
  <title>CloudBridge</title>
  <style>
    :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #101820; color: #f4f7fb; }
    main { max-width: 720px; margin: 0 auto; padding: 22px 16px 42px; }
    header { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:18px; }
    h1 { font-size: 24px; margin: 0; letter-spacing: 0; }
    .pill { border:1px solid #375066; border-radius:999px; padding:7px 10px; color:#a8c7dd; font-size:13px; }
    section { border-top: 1px solid #2d4052; padding-top: 18px; margin-top: 18px; }
    label { display: block; margin: 14px 0 8px; font-weight: 700; }
    input, textarea, button {
      width: 100%; box-sizing: border-box; border: 1px solid #36536a; border-radius: 8px;
      background: #152332; color: #f8fafc; font: inherit;
    }
    input, textarea { padding: 12px; }
    textarea { min-height: 150px; resize: vertical; }
    button { margin-top: 10px; padding: 13px 14px; border: 0; background: #5eead4; color: #042f2e; font-weight: 850; }
    button.secondary { background: #284156; color: #f8fafc; }
    button.danger { background: #fca5a5; color: #450a0a; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .status { margin-top: 16px; padding: 12px; border-radius: 8px; background: #172a3a; color: #cbd5e1; min-height: 24px; }
    .muted { color: #9fb4c6; line-height: 1.5; }
    .hidden { display:none; }
  </style>
</head>
<body>
<main>
  <header>
    <h1>CloudBridge</h1>
    <div id="pairState" class="pill">Checking</div>
  </header>

  <section id="pairPanel" class="hidden">
    <p class="muted">Pair this iPhone from the Windows tray app. Scan or open the pairing link, then tap Pair.</p>
    <label for="pairCode">Pairing code</label>
    <input id="pairCode" autocomplete="one-time-code" placeholder="Pairing code">
    <button id="pairBtn">Pair iPhone</button>
  </section>

  <section id="appPanel" class="hidden">
    <label for="content">Text</label>
    <textarea id="content" placeholder="Paste text here, or pull latest text from PC."></textarea>
    <div class="row">
      <button id="pasteBtn" class="secondary">Paste</button>
      <button id="copyBtn" class="secondary">Copy</button>
    </div>
    <button id="pushBtn">Push to PC</button>
    <button id="pullBtn" class="secondary">Pull from PC</button>

    <label for="file">File</label>
    <input id="file" type="file">
    <button id="fileBtn">Send File to PC</button>
    <button id="resetBtn" class="danger">Forget Pairing</button>
  </section>

  <div id="status" class="status">Ready.</div>
</main>
<script>
const deviceId = localStorage.getItem("cloudbridge_device_id") || ("ios-" + Math.random().toString(36).slice(2));
localStorage.setItem("cloudbridge_device_id", deviceId);
const params = new URLSearchParams(location.search);
const pairCodeInput = document.getElementById("pairCode");
if (params.get("code")) pairCodeInput.value = params.get("code");
const statusBox = document.getElementById("status");
const pairState = document.getElementById("pairState");
const pairPanel = document.getElementById("pairPanel");
const appPanel = document.getElementById("appPanel");
const content = document.getElementById("content");
function token() { return localStorage.getItem("cloudbridge_token") || ""; }
function status(message) { statusBox.textContent = message; }
function headers(extra = {}) { return { "Authorization": "Bearer " + token(), ...extra }; }
function setPaired(isPaired) {
  pairState.textContent = isPaired ? "Paired" : "Not paired";
  pairPanel.classList.toggle("hidden", isPaired);
  appPanel.classList.toggle("hidden", !isPaired);
}
async function checkPairing() {
  if (!token()) { setPaired(false); return; }
  const response = await fetch("/api/me", { headers: headers() });
  setPaired(response.ok);
  if (!response.ok) localStorage.removeItem("cloudbridge_token");
}
document.getElementById("pairBtn").onclick = async () => {
  try {
    const response = await fetch("/api/pairing/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: pairCodeInput.value.trim(), device_id: deviceId, label: "iPhone" })
    });
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    localStorage.setItem("cloudbridge_token", data.token);
    setPaired(true);
    status("iPhone paired.");
  } catch (err) { status("Pairing failed: " + err.message); }
};
document.getElementById("pasteBtn").onclick = async () => {
  try { content.value = await navigator.clipboard.readText(); status("Pasted from iPhone clipboard."); }
  catch { status("Paste blocked by iOS. Paste manually into the text box."); }
};
document.getElementById("copyBtn").onclick = async () => {
  try { await navigator.clipboard.writeText(content.value); status("Copied to iPhone clipboard."); }
  catch { status("Copy blocked by iOS. Select text manually."); }
};
document.getElementById("pushBtn").onclick = async () => {
  try {
    const response = await fetch("/api/clipboard/push", {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ content: content.value, source: "ios-pwa", device_id: deviceId })
    });
    if (!response.ok) throw new Error(await response.text());
    status("Sent to PC. Press Ctrl+V on Windows.");
  } catch (err) { status("Push failed: " + err.message); }
};
document.getElementById("pullBtn").onclick = async () => {
  try {
    const response = await fetch("/api/clipboard/latest?device_id=" + encodeURIComponent(deviceId), { headers: headers() });
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    if (!data.has_update) { status("No new clipboard from PC."); return; }
    content.value = data.item.content;
    try { await navigator.clipboard.writeText(data.item.content); status("Pulled from PC and copied to iPhone clipboard."); }
    catch { status("Pulled from PC. Use Copy if iOS did not allow clipboard write."); }
  } catch (err) { status("Pull failed: " + err.message); }
};
document.getElementById("fileBtn").onclick = async () => {
  try {
    const input = document.getElementById("file");
    if (!input.files.length) throw new Error("Choose a file first.");
    const form = new FormData();
    form.append("file", input.files[0]);
    form.append("source", "ios-pwa");
    form.append("device_id", deviceId);
    const response = await fetch("/api/files/upload", { method: "POST", headers: headers(), body: form });
    if (!response.ok) throw new Error(await response.text());
    status("File sent. Windows Agent will download it.");
  } catch (err) { status("File send failed: " + err.message); }
};
document.getElementById("resetBtn").onclick = () => {
  localStorage.removeItem("cloudbridge_token");
  setPaired(false);
  status("Pairing removed from this iPhone.");
};
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
checkPairing().catch(() => setPaired(false));
</script>
</body>
</html>
"""


@app.get("/health")
def health() -> dict[str, str]:
    return {
        "ok": "true",
        "service": APP_NAME,
        "mode": "supabase" if SB is not None else "memory",
    }


@app.get("/", response_class=HTMLResponse)
def mobile_app() -> str:
    return PWA_HTML


@app.get("/app", response_class=HTMLResponse)
def mobile_app_alias() -> str:
    return PWA_HTML


@app.get("/manifest.json")
def manifest() -> JSONResponse:
    return JSONResponse(
        {
            "name": "CloudBridge",
            "short_name": "CloudBridge",
            "start_url": "/app",
            "display": "standalone",
            "background_color": "#101820",
            "theme_color": "#101820",
            "icons": [
                {
                    "src": "/icon.svg",
                    "sizes": "any",
                    "type": "image/svg+xml",
                    "purpose": "any maskable",
                }
            ],
        }
    )


@app.get("/icon.svg")
def icon() -> HTMLResponse:
    return HTMLResponse(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">'
        '<rect width="512" height="512" rx="96" fill="#101820"/>'
        '<path d="M156 178h200v156H156z" fill="#5eead4"/>'
        '<path d="M196 138h120v52H196zM196 322h120v52H196z" fill="#f8fafc"/>'
        "</svg>",
        media_type="image/svg+xml",
    )


@app.get("/sw.js")
def service_worker() -> PlainTextResponse:
    return PlainTextResponse(
        "self.addEventListener('install',event=>self.skipWaiting());\n"
        "self.addEventListener('fetch',event=>{});\n",
        media_type="application/javascript",
    )


@app.get("/api/me", dependencies=[Depends(require_any_auth)])
def me(auth: AuthContext = Depends(require_any_auth)) -> dict[str, Any]:
    return {"ok": True, "auth": auth.kind, "device_id": auth.device_id}


@app.post("/api/pairing/create", dependencies=[Depends(require_admin_auth)])
def create_pairing(payload: PairingCreateRequest) -> dict[str, Any]:
    record = create_pairing_record(payload)
    base = public_base_url()
    pairing_url = f"{base}/app?code={record['code']}" if base else f"/app?code={record['code']}"
    return {
        "ok": True,
        "code": record["code"],
        "pairing_url": pairing_url,
        "expires_at": record["expires_at"],
    }


@app.post("/api/pairing/claim")
def claim_pairing_endpoint(payload: PairingClaimRequest) -> dict[str, Any]:
    claimed = claim_pairing(payload)
    return {"ok": True, **claimed}


@app.post("/api/clipboard/push", dependencies=[Depends(require_any_auth)])
def push_clipboard(payload: ClipboardPushRequest) -> dict[str, Any]:
    return {"ok": True, "item": insert_clipboard_record(payload)}


@app.get("/api/clipboard/latest", dependencies=[Depends(require_any_auth)])
def latest_clipboard(
    device_id: str | None = Query(default=None),
    since_id: str | None = Query(default=None),
) -> dict[str, Any]:
    latest = get_latest_clipboard()
    if latest is None:
        return {"ok": True, "has_update": False, "item": None}
    if since_id and str(latest["id"]) == since_id:
        return {"ok": True, "has_update": False, "item": None}
    if device_id and latest["device_id"] == device_id:
        return {"ok": True, "has_update": False, "item": None}
    return {"ok": True, "has_update": True, "item": latest}


@app.post("/api/files/upload", dependencies=[Depends(require_any_auth)])
async def upload_file(
    file: UploadFile = File(...),
    source: str = Form(default="ios"),
    device_id: str = Form(...),
) -> dict[str, Any]:
    file_id = str(uuid.uuid4())
    original_name = safe_filename(file.filename or "upload.bin")
    mime_type = file.content_type or "application/octet-stream"
    body = await file.read()
    storage_ref = upload_payload_to_storage(file_id, original_name, body, mime_type)
    record = {
        "id": file_id,
        "filename": original_name,
        "storage_path": storage_ref if SB is not None else None,
        "stored_name": storage_ref if SB is None else None,
        "size": len(body),
        "mime_type": mime_type,
        "source": source,
        "device_id": device_id,
        "uploaded_at": now_iso(),
        "status": "pending",
        "downloaded_at": None,
        "expires_at": (now_dt() + timedelta(seconds=FILE_TTL_SECONDS)).isoformat(),
    }
    saved = insert_file_record(record)
    return {"ok": True, "item": public_file_record(saved)}


@app.get("/api/files/pending", dependencies=[Depends(require_any_auth)])
def pending_files(device_id: str | None = Query(default=None)) -> dict[str, Any]:
    return {"ok": True, "items": [public_file_record(item) for item in list_pending_files(device_id)]}


@app.get("/api/files/{file_id}/download", dependencies=[Depends(require_any_auth)])
def download_file(file_id: str) -> FileResponse:
    record = get_file_record(file_id)
    if not record:
        raise HTTPException(status_code=404, detail="File not found")
    if record.get("expires_at") and parse_dt(record["expires_at"]) <= now_dt():
        raise HTTPException(status_code=410, detail="File expired")

    payload = download_payload(record)
    temp_path = UPLOAD_DIR / f"download-{file_id}-{safe_filename(record['filename'])}"
    temp_path.write_bytes(payload)
    return FileResponse(path=temp_path, filename=record["filename"], media_type=record["mime_type"])


@app.post("/api/files/{file_id}/ack", dependencies=[Depends(require_any_auth)])
def ack_file(file_id: str) -> dict[str, Any]:
    record = get_file_record(file_id)
    if not record:
        raise HTTPException(status_code=404, detail="File not found")

    if SB is not None:
        updated = (
            SB.table("cloudbridge_files")
            .update({"status": "downloaded", "downloaded_at": now_iso()})
            .eq("id", file_id)
            .execute()
            .data[0]
        )
        if DELETE_AFTER_ACK:
            delete_payload(record)
        return {"ok": True, "item": public_file_record(updated)}

    record["status"] = "downloaded"
    record["downloaded_at"] = now_iso()
    if DELETE_AFTER_ACK:
        delete_payload(record)
    return {"ok": True, "item": public_file_record(record)}


@app.post("/api/admin/cleanup", dependencies=[Depends(require_admin_auth)])
def cleanup_expired_files(max_age_seconds: int = Query(default=FILE_TTL_SECONDS, ge=60)) -> dict[str, Any]:
    removed = 0
    if SB is not None:
        expired = (
            SB.table("cloudbridge_files")
            .select("*")
            .lt("expires_at", now_iso())
            .neq("status", "expired")
            .execute()
            .data
        )
        for record in expired:
            delete_payload(record)
            SB.table("cloudbridge_files").update({"status": "expired"}).eq("id", record["id"]).execute()
            removed += 1
        return {"ok": True, "removed": removed}

    cutoff = time.time() - max_age_seconds
    for _, record in list(file_records.items()):
        stored_name = record.get("stored_name")
        if not stored_name:
            continue
        stored_path = UPLOAD_DIR / stored_name
        if stored_path.exists() and stored_path.stat().st_mtime < cutoff:
            stored_path.unlink()
            record["status"] = "expired"
            removed += 1
    return {"ok": True, "removed": removed}

