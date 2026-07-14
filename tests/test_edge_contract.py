from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FUNCTION = (ROOT / "supabase/functions/cloudbridge/index.ts").read_text(encoding="utf-8")
MIGRATION = (ROOT / "supabase/migrations/20260714114538_cloudbridge_file_manager.sql").read_text(
    encoding="utf-8"
)
PWA = (ROOT / "docs/app/index.html").read_text(encoding="utf-8")


def test_file_manager_api_contract_is_present():
    routes = (
        "/api/file-folders/tree",
        "/api/file-folders",
        "/api/files/browse",
        "/api/files/search",
        "/api/files/trash",
        "/api/files/storage",
        "/api/files/bulk",
    )
    for route in routes:
        assert route in FUNCTION
    assert 'req.method === "PATCH"' in FUNCTION
    assert 'req.method === "DELETE"' in FUNCTION


def test_file_manager_schema_supports_nested_folders_and_trash():
    expected = (
        "cloudbridge_file_folders",
        "parent_id",
        "folder_id",
        "trashed_at",
        "trashed_from_folder_id",
        "cloudbridge_files_folder_idx",
    )
    for value in expected:
        assert value in MIGRATION
    assert "enable row level security" in MIGRATION.lower()


def test_private_storage_path_is_removed_from_public_file_records():
    assert 'delete copy.storage_path' in FUNCTION
    assert "removeStoredFiles" in FUNCTION
    assert 'storage.from(BUCKET).remove' in FUNCTION


def test_manager_ui_contains_core_clipboard_and_file_controls():
    labels = (
        "Pinned",
        "Recent",
        "Inbox",
        "Trash",
        "New folder",
        "Move",
        "Delete permanently",
    )
    for label in labels:
        assert label in PWA
    assert "localStorage" in PWA
    assert 'confirmAction("Forget pairing?"' in PWA
