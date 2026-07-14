from __future__ import annotations

import hashlib
import os
import re
import socket
import sys
import time
from pathlib import Path
from typing import Any

import pyperclip
import requests
from dotenv import load_dotenv

try:
    from winotify import Notification
except Exception:  # pragma: no cover
    Notification = None


load_dotenv()

BASE_URL = os.getenv("CLOUD_BRIDGE_BASE_URL", "http://127.0.0.1:8000").rstrip("/")
TOKEN = os.getenv("CLOUD_BRIDGE_TOKEN", "change-me")
DEVICE_ID = os.getenv("CLOUD_BRIDGE_DEVICE_ID") or f"windows-{socket.gethostname()}"
POLL_INTERVAL_MS = int(os.getenv("POLL_INTERVAL_MS", "1500"))
DOWNLOAD_DIR = Path(os.getenv("DOWNLOAD_DIR") or (Path.home() / "Downloads" / "CloudBridge"))

HEADERS = {"Authorization": f"Bearer {TOKEN}"}
DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)


def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def log(message: str) -> None:
    print(f"[cloud-bridge] {message}", flush=True)


def notify(title: str, message: str) -> None:
    if Notification is None:
        log(f"{title}: {message}")
        return
    try:
        toast = Notification(app_id="Cloud Clipboard & File Bridge", title=title, msg=message)
        toast.show()
    except Exception:
        log(f"{title}: {message}")


def request_json(method: str, path: str, **kwargs: Any) -> dict[str, Any] | None:
    url = f"{BASE_URL}{path}"
    response = requests.request(method, url, headers=HEADERS, timeout=20, **kwargs)
    if response.status_code == 401:
        raise RuntimeError("Server rejected CLOUD_BRIDGE_TOKEN")
    response.raise_for_status()
    return response.json()


def health() -> dict[str, Any] | None:
    response = requests.get(f"{BASE_URL}/health", timeout=10)
    response.raise_for_status()
    return response.json()


def create_pairing(label: str = "Windows PC") -> dict[str, Any] | None:
    payload = {"device_id": DEVICE_ID, "label": label}
    return request_json("POST", "/api/pairing/create", json=payload)


def push_clipboard(content: str) -> dict[str, Any] | None:
    payload = {"content": content, "source": "windows", "device_id": DEVICE_ID}
    return request_json("POST", "/api/clipboard/push", json=payload)


def pull_clipboard(since_id: str | None) -> dict[str, Any] | None:
    params = {"device_id": DEVICE_ID}
    if since_id:
        params["since_id"] = since_id
    return request_json("GET", "/api/clipboard/latest", params=params)


def sanitize_filename(filename: str) -> str:
    filename = Path(filename).name.strip()
    filename = re.sub(r'[<>:"/\\|?*\x00-\x1F]', "_", filename)
    return filename or "download.bin"


def unique_path(filename: str) -> Path:
    base = DOWNLOAD_DIR / sanitize_filename(filename)
    if not base.exists():
        return base

    stem = base.stem
    suffix = base.suffix
    for index in range(1, 1000):
        candidate = DOWNLOAD_DIR / f"{stem} ({index}){suffix}"
        if not candidate.exists():
            return candidate
    return DOWNLOAD_DIR / f"{stem}-{int(time.time())}{suffix}"


def download_file(file_item: dict[str, Any]) -> None:
    file_id = file_item["id"]
    target = unique_path(file_item.get("filename") or "download.bin")
    url = f"{BASE_URL}/api/files/{file_id}/download"

    with requests.get(url, headers=HEADERS, stream=True, timeout=120) as response:
        response.raise_for_status()
        with target.open("wb") as out:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    out.write(chunk)

    request_json("POST", f"/api/files/{file_id}/ack")
    notify("CloudBridge file received", str(target))
    log(f"Downloaded {target}")


def poll_files() -> None:
    data = request_json("GET", "/api/files/pending", params={"device_id": DEVICE_ID})
    if not data:
        return
    for item in data.get("items", []):
        try:
            download_file(item)
        except Exception as exc:
            log(f"File download failed for {item.get('filename')}: {exc}")


def main() -> int:
    if not BASE_URL or not TOKEN:
        log("Set CLOUD_BRIDGE_BASE_URL and CLOUD_BRIDGE_TOKEN first.")
        return 2

    log(f"Agent started. device_id={DEVICE_ID}, server={BASE_URL}, downloads={DOWNLOAD_DIR}")

    last_local_hash = ""
    last_seen_clipboard_id: str | None = None
    interval = max(POLL_INTERVAL_MS, 500) / 1000

    while True:
        try:
            local_text = pyperclip.paste()
            if isinstance(local_text, str) and local_text:
                local_hash = text_hash(local_text)
                if local_hash != last_local_hash:
                    pushed = push_clipboard(local_text)
                    item = (pushed or {}).get("item") or {}
                    last_seen_clipboard_id = item.get("id") or last_seen_clipboard_id
                    last_local_hash = local_hash
                    log("Pushed Windows clipboard to cloud")

            latest = pull_clipboard(last_seen_clipboard_id)
            if latest and latest.get("has_update") and latest.get("item"):
                item = latest["item"]
                content = item["content"]
                pyperclip.copy(content)
                last_seen_clipboard_id = item["id"]
                last_local_hash = text_hash(content)
                notify("CloudBridge clipboard updated", "Text from cloud is ready to paste.")
                log(f"Pulled clipboard update from {item.get('source')}")

            poll_files()

        except KeyboardInterrupt:
            log("Agent stopped.")
            return 0
        except Exception as exc:
            log(f"Loop error: {exc}")

        time.sleep(interval)


if __name__ == "__main__":
    sys.exit(main())
