import io
import os
import sys
from pathlib import Path

os.environ["CLOUD_BRIDGE_TOKEN"] = "test-token"
os.environ["CLOUD_BRIDGE_UPLOAD_DIR"] = str(Path(__file__).parent / "tmp_uploads")

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

from fastapi.testclient import TestClient  # noqa: E402
from main import app  # noqa: E402


client = TestClient(app)
headers = {"Authorization": "Bearer test-token"}


def test_health_is_public():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["ok"] == "true"


def test_clipboard_requires_auth():
    response = client.get("/api/clipboard/latest")
    assert response.status_code == 401


def test_clipboard_push_and_latest_filters_echo():
    payload = {"content": "hello from ios", "source": "ios", "device_id": "iphone"}
    pushed = client.post("/api/clipboard/push", json=payload, headers=headers)
    assert pushed.status_code == 200
    item = pushed.json()["item"]

    latest_for_windows = client.get("/api/clipboard/latest?device_id=windows", headers=headers)
    assert latest_for_windows.status_code == 200
    assert latest_for_windows.json()["has_update"] is True
    assert latest_for_windows.json()["item"]["content"] == "hello from ios"

    latest_for_iphone = client.get("/api/clipboard/latest?device_id=iphone", headers=headers)
    assert latest_for_iphone.status_code == 200
    assert latest_for_iphone.json()["has_update"] is False

    latest_since_seen = client.get(f"/api/clipboard/latest?since_id={item['id']}", headers=headers)
    assert latest_since_seen.json()["has_update"] is False


def test_pairing_claim_creates_device_token():
    create = client.post(
        "/api/pairing/create",
        json={"device_id": "windows-test", "label": "Windows Test"},
        headers=headers,
    )
    assert create.status_code == 200
    code = create.json()["code"]

    claim = client.post(
        "/api/pairing/claim",
        json={"code": code, "device_id": "iphone-test-pair", "label": "iPhone Test"},
    )
    assert claim.status_code == 200
    device_token = claim.json()["token"]

    me = client.get("/api/me", headers={"Authorization": f"Bearer {device_token}"})
    assert me.status_code == 200
    assert me.json()["device_id"] == "iphone-test-pair"

    second_claim = client.post(
        "/api/pairing/claim",
        json={"code": code, "device_id": "iphone-test-pair-2", "label": "iPhone Test 2"},
    )
    assert second_claim.status_code == 404


def test_file_upload_pending_download_ack():
    upload = client.post(
        "/api/files/upload",
        headers=headers,
        data={"source": "ios", "device_id": "iphone"},
        files={"file": ("hello.txt", io.BytesIO(b"hello file"), "text/plain")},
    )
    assert upload.status_code == 200
    file_item = upload.json()["item"]
    assert file_item["status"] == "pending"

    pending = client.get("/api/files/pending?device_id=windows", headers=headers)
    assert pending.status_code == 200
    assert any(item["id"] == file_item["id"] for item in pending.json()["items"])

    download = client.get(f"/api/files/{file_item['id']}/download", headers=headers)
    assert download.status_code == 200
    assert download.content == b"hello file"

    ack = client.post(f"/api/files/{file_item['id']}/ack", headers=headers)
    assert ack.status_code == 200
    assert ack.json()["item"]["status"] == "downloaded"
