from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FUNCTION = (ROOT / "supabase/functions/cloudbridge/index.ts").read_text(encoding="utf-8")
REMOVAL_MIGRATION = (ROOT / "supabase/migrations/20260716053016_simplify_cloudbridge_files_pinned_temporary.sql").read_text(
    encoding="utf-8"
)
QUICK_MIGRATION = (
    ROOT / "supabase/migrations/20260716030758_cloudbridge_quick_actions_performance.sql"
).read_text(encoding="utf-8")
PWA = (ROOT / "docs/app/index.html").read_text(encoding="utf-8")


def test_file_api_only_keeps_transfer_history_and_pin_contracts():
    for route in (
        "/api/files/upload",
        "/api/files/pending",
        "/api/files/history",
        "/download",
        "/ack",
        "(pin|unpin)",
    ):
        assert route in FUNCTION
    for removed in (
        "/api/file-folders",
        "/api/files/workspace",
        "/api/files/browse",
        "/api/files/search",
        "/api/files/trash",
        "/api/files/storage",
        "/api/files/bulk",
    ):
        assert removed not in FUNCTION


def test_removal_migration_preserves_files_before_dropping_manager_schema():
    assert "update public.cloudbridge_files" in REMOVAL_MIGRATION
    assert "pinned = true" in REMOVAL_MIGRATION
    for value in ("folder_id", "trashed_at", "trashed_from_folder_id"):
        assert f"drop column if exists {value}" in REMOVAL_MIGRATION
    assert "drop table if exists public.cloudbridge_file_folders" in REMOVAL_MIGRATION
    assert "drop function if exists public.cloudbridge_storage_usage" in REMOVAL_MIGRATION


def test_private_storage_path_is_removed_from_public_file_records():
    assert 'delete copy.storage_path' in FUNCTION
    assert "removeStoredFiles" in FUNCTION
    assert 'storage.from(BUCKET).remove' in FUNCTION


def test_pwa_contains_lightweight_pinned_and_temporary_file_lists():
    for label in ("Pinned", "Temporary", "Open", "Unpin file?"):
        assert label in PWA
    for removed in ("Inbox", "Trash", "New folder", "Delete permanently", "Search files"):
        assert removed not in PWA
    assert "localStorage" in PWA
    assert 'confirmAction("Forget pairing?"' in PWA


def test_web_opens_files_inline_without_forcing_download():
    assert 'iconButton("open", "Open")' in PWA
    assert "async function openFile(file)" in PWA
    assert 'link.target = "_blank"' in PWA
    assert "link.download" not in PWA
    assert '"Content-Disposition": `inline;' in FUNCTION


def test_all_clipboard_and_file_items_can_be_edited():
    assert 'req.method === "PATCH" && clipboardEditMatch' in FUNCTION
    assert 'req.method === "PATCH" && fileRenameMatch' in FUNCTION
    assert 'iconButton("edit", "Edit")' in PWA
    assert 'iconButton("edit", "Rename")' in PWA
    assert "openClipboardEditor(item)" in PWA
    assert "openFileRenamer(file)" in PWA
    assert "if (!pinned)" not in PWA[PWA.index("function openClipboardEditor"):PWA.index("function fileMeta")]


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


def test_file_history_uses_cursor_pagination_without_workspace_cache():
    assert "before_uploaded_at" in FUNCTION
    assert "next_cursor" in FUNCTION
    assert "before_uploaded_at" in PWA
    assert "WORKSPACE_CACHE" not in PWA
    assert "loadMoreFiles" in PWA


def test_quick_actions_setup_is_available_in_manager():
    for label in ("Quick Actions", "CloudBridge Push", "CloudBridge Pull", "Create setup key"):
        assert label in PWA
    assert 'if (token()) setPaired(true)' in PWA
    assert "Get Text from Clipboard" in PWA
    assert "request body <strong>File</strong> = Text" in PWA


def test_quick_push_accepts_ios_shortcuts_raw_body():
    assert 'contentType.includes("application/json")' in FUNCTION
    assert 'content = await req.text();' in FUNCTION
