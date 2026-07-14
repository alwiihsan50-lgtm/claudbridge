from __future__ import annotations

import os
import subprocess
import threading
import time
from pathlib import Path
from tkinter import Tk, filedialog
from urllib.parse import quote

import pyperclip
import pystray
import qrcode
from PIL import Image, ImageDraw
from pystray import MenuItem as item

import agent


APP_URL = os.getenv(
    "CLOUD_BRIDGE_APP_URL",
    "https://alwiihsan50-lgtm.github.io/cloud-clipboard-file-bridge/app/",
).rstrip("/")
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
    state = agent.SyncState()
    local_interval = max(agent.LOCAL_CLIPBOARD_INTERVAL_MS, 500) / 1000
    fallback_interval = max(agent.FALLBACK_POLL_INTERVAL_MS, 30000) / 1000
    health_interval = max(agent.HEALTH_INTERVAL_MS, 30000) / 1000
    last_fallback_at = 0.0
    last_health_at = 0.0

    def on_realtime_status(message: str) -> None:
        if message == "subscribed":
            set_status(connected=True, last_sync=time.strftime("%H:%M:%S"), last_error="")
        else:
            set_status(connected=False, last_error=message[:80])

    def on_realtime_files(files: list[Path]) -> None:
        if files:
            set_status(last_file=files[-1].name, last_sync=time.strftime("%H:%M:%S"), connected=True)

    if agent.realtime_available():
        realtime_thread = threading.Thread(
            target=agent.run_realtime_listener,
            args=(state, stop_event, on_realtime_status, on_realtime_files),
            daemon=True,
        )
        realtime_thread.start()
    else:
        set_status(connected=False, last_error="Realtime disabled; using fallback polling")

    while not stop_event.is_set():
        try:
            now_value = time.monotonic()
            state.check_local_clipboard()

            if now_value - last_health_at >= health_interval:
                agent.health()
                last_health_at = now_value

            if now_value - last_fallback_at >= fallback_interval:
                files = state.sync_remote()
                if files:
                    set_status(last_file=files[-1].name)
                last_fallback_at = now_value

            set_status(connected=True, last_sync=time.strftime("%H:%M:%S"), last_error="")
        except Exception as exc:
            set_status(connected=False, last_error=str(exc)[:80])
        stop_event.wait(local_interval)


def open_downloads() -> None:
    agent.DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
    os.startfile(agent.DOWNLOAD_DIR)


def copy_cloud_url() -> None:
    pyperclip.copy(agent.BASE_URL)
    agent.notify("CloudBridge", "Cloud URL copied.")


def open_manager() -> None:
    manager_url = (
        f"{APP_URL}/#manager_token={quote(agent.TOKEN, safe='')}"
        f"&device_id={quote(agent.DEVICE_ID, safe='')}"
    )
    os.startfile(manager_url)


def choose_file() -> str:
    root = Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    try:
        return filedialog.askopenfilename(title="Send file to iPhone")
    finally:
        root.destroy()


def send_file_to_iphone() -> None:
    def worker() -> None:
        try:
            selected = choose_file()
            if not selected:
                return
            data = agent.upload_file(selected)
            item_data = (data or {}).get("item") or {}
            filename = item_data.get("filename") or Path(selected).name
            set_status(last_file=filename, last_sync=time.strftime("%H:%M:%S"), connected=True)
            agent.notify("CloudBridge file sent", f"{filename} is ready on iPhone.")
        except Exception as exc:
            set_status(connected=False, last_error=str(exc)[:80])
            agent.notify("CloudBridge file send failed", str(exc))

    threading.Thread(target=worker, daemon=True).start()


def create_pairing_link() -> None:
    try:
        data = agent.create_pairing("Windows PC")
        code = (data or {}).get("code")
        if not code:
            raise RuntimeError("Server did not return a pairing code")
        pairing_url = f"{APP_URL}/?code={code}"
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
        item("Open CloudBridge Manager", open_manager),
        item("Send file to iPhone", send_file_to_iphone),
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
