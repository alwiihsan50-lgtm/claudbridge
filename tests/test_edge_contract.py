from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FUNCTION = (ROOT / "supabase/functions/cloudbridge/index.ts").read_text(encoding="utf-8")
MIGRATION = (ROOT / "supabase/migrations/20260714114538_cloudbridge_file_manager.sql").read_text(
    encoding="utf-8"
)
QUICK_MIGRATION = (
    ROOT / "supabase/migrations/20260716030758_cloudbridge_quick_actions_performance.sql"
).read_text(encoding="utf-8")
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


def test_quick_actions_are_scoped_and_revocable():
    for route in (
        "/api/quick-actions/setup",
        "/api/quick/clipboard/push",
        "/api/quick/clipboard/pull",
    ):
        assert route in FUNCTION
    assert 'access_scope !== "clipboard_quick"' in FUNCTION
    assert 'auth.access_scope === "clipboard_quick"' in FUNCTION
    assert "clipboard_quick" in QUICK_MIGRATION
    assert "parent_device_id" in QUICK_MIGRATION


def test_file_workspace_uses_aggregate_pagination_and_persistent_cache():
    assert "/api/files/workspace" in FUNCTION
    assert "cloudbridge_storage_usage" in FUNCTION
    assert "cloudbridge_storage_usage" in QUICK_MIGRATION
    assert "security invoker" in QUICK_MIGRATION.lower()
    assert "limit=30&offset=0" in PWA
    assert "WORKSPACE_CACHE_MAX_MS = 86400000" in PWA
    assert "loadMoreFiles" in PWA


def test_quick_actions_setup_is_available_in_manager():
    for label in ("Quick Actions", "CloudBridge Push", "CloudBridge Pull", "Create setup key"):
        assert label in PWA
    assert 'if (token()) setPaired(true)' in PWA
    assert "request body <strong>File</strong> = Clipboard" in PWA


def test_quick_push_accepts_ios_shortcuts_raw_body():
    assert 'contentType.includes("application/json")' in FUNCTION
    assert 'content = await req.text();' in FUNCTION
