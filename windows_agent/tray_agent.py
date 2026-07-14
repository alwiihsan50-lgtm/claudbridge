from __future__ import annotations

import os
import subprocess
import threading
import time
from pathlib import Path

import pyperclip
import pystray
import qrcode
from PIL import Image, ImageDraw
from pystray import MenuItem as item

import agent


stop_event = threading.Event()
status_lock = threading.Lock()
status = {
    "connected": False,
    "last_sync": "never",
    "last_error": "",
    "last_file": "",
}


def set_status(**kwargs: str | bool) -> None:
    with status_lock:
        status.update(kwargs)


def status_title() -> str:
    with status_lock:
        if status["connected"]:
            return f"Connected - last sync {status['last_sync']}"
        if status["last_error"]:
            return f"Disconnected - {status['last_error']}"
        return "Starting"


def make_icon() -> Image.Image:
    image = Image.new("RGBA", (64, 64), (16, 24, 32, 255))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((12, 18, 52, 46), radius=6, fill=(94, 234, 212, 255))
    draw.rectangle((22, 10, 42, 20), fill=(248, 250, 252, 255))
    draw.rectangle((22, 44, 42, 54), fill=(248, 250, 252, 255))
    return image


def sync_loop() -> None:
    last_local_hash = ""
    last_seen_clipboard_id: str | None = None
    interval = max(agent.POLL_INTERVAL_MS, 500) / 1000

    while not stop_event.is_set():
        try:
            agent.health()
            local_text = pyperclip.paste()
            if isinstance(local_text, str) and local_text:
                local_hash = agent.text_hash(local_text)
                if local_hash != last_local_hash:
                    pushed = agent.push_clipboard(local_text)
                    item_data = (pushed or {}).get("item") or {}
                    last_seen_clipboard_id = item_data.get("id") or last_seen_clipboard_id
                    last_local_hash = local_hash

            latest = agent.pull_clipboard(last_seen_clipboard_id)
            if latest and latest.get("has_update") and latest.get("item"):
                item_data = latest["item"]
                content = item_data["content"]
                pyperclip.copy(content)
                last_seen_clipboard_id = item_data["id"]
                last_local_hash = agent.text_hash(content)
                agent.notify("CloudBridge clipboard updated", "Text from cloud is ready to paste.")

            before = set(p.name for p in agent.DOWNLOAD_DIR.glob("*")) if agent.DOWNLOAD_DIR.exists() else set()
            agent.poll_files()
            after = set(p.name for p in agent.DOWNLOAD_DIR.glob("*")) if agent.DOWNLOAD_DIR.exists() else set()
            new_files = sorted(after - before)
            if new_files:
                set_status(last_file=new_files[-1])

            set_status(connected=True, last_sync=time.strftime("%H:%M:%S"), last_error="")
        except Exception as exc:
            set_status(connected=False, last_error=str(exc)[:80])
        stop_event.wait(interval)


def open_downloads() -> None:
    agent.DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
    os.startfile(agent.DOWNLOAD_DIR)


def copy_cloud_url() -> None:
    pyperclip.copy(agent.BASE_URL)
    agent.notify("CloudBridge", "Cloud URL copied.")


def create_pairing_link() -> None:
    try:
        data = agent.create_pairing("Windows PC")
        pairing_url = (data or {}).get("pairing_url")
        code = (data or {}).get("code")
        if not pairing_url:
            raise RuntimeError("Server did not return a pairing URL")
        if pairing_url.startswith("/"):
            pairing_url = f"{agent.BASE_URL}{pairing_url}"
        pyperclip.copy(pairing_url)
        qr_path = Path(os.getenv("TEMP", str(Path.home()))) / "cloudbridge-pairing-qr.png"
        qrcode.make(pairing_url).save(qr_path)
        agent.notify("CloudBridge pairing", f"QR opened and link copied. Code: {code}")
        os.startfile(qr_path)
    except Exception as exc:
        agent.notify("CloudBridge pairing failed", str(exc))


def open_logs() -> None:
    logs_dir = Path(__file__).resolve().parents[1] / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    os.startfile(logs_dir)


def restart_agent(icon: pystray.Icon) -> None:
    stop_event.set()
    icon.stop()
    subprocess.Popen(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(Path(__file__).resolve().parents[1] / "start-cloudbridge.ps1")])


def quit_agent(icon: pystray.Icon) -> None:
    stop_event.set()
    icon.stop()


def main() -> None:
    worker = threading.Thread(target=sync_loop, daemon=True)
    worker.start()
    menu = pystray.Menu(
        item(lambda _: status_title(), None, enabled=False),
        item("Show pairing link", create_pairing_link),
        item("Copy cloud URL", copy_cloud_url),
        item("Open downloads folder", open_downloads),
        item("Open logs", open_logs),
        item("Restart", restart_agent),
        item("Quit", quit_agent),
    )
    icon = pystray.Icon("CloudBridge", make_icon(), "CloudBridge", menu)
    icon.run()


if __name__ == "__main__":
    main()
