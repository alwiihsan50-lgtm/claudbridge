import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";

const PROJECT_REF = "ajlkfzgpheegmwsnspxw";
const APP_NAME = "CloudBridge";
const BUCKET = Deno.env.get("SUPABASE_STORAGE_BUCKET") ?? "cloudbridge-files";
const FILE_TTL_SECONDS = Number(
  Deno.env.get("CLOUD_BRIDGE_FILE_TTL_SECONDS") ?? "86400",
);
const PAIRING_TTL_SECONDS = Number(
  Deno.env.get("CLOUD_BRIDGE_PAIRING_TTL_SECONDS") ?? "600",
);
const CLIPBOARD_RETENTION_SECONDS = Number(
  Deno.env.get("CLOUD_BRIDGE_CLIPBOARD_RETENTION_SECONDS") ?? "604800",
);
const FILE_CLEANUP_GRACE_SECONDS = Number(
  Deno.env.get("CLOUD_BRIDGE_FILE_CLEANUP_GRACE_SECONDS") ?? "86400",
);
const TRASH_RETENTION_SECONDS = Number(
  Deno.env.get("CLOUD_BRIDGE_TRASH_RETENTION_SECONDS") ?? "604800",
);
const CLEANUP_INTERVAL_SECONDS = Number(
  Deno.env.get("CLOUD_BRIDGE_CLEANUP_INTERVAL_SECONDS") ?? "86400",
);
const STORAGE_QUOTA_BYTES = Number(
  Deno.env.get("CLOUD_BRIDGE_STORAGE_QUOTA_BYTES") ?? "1073741824",
);
const PUBLIC_BASE_URL = Deno.env.get("CLOUD_BRIDGE_PUBLIC_URL") ??
  `https://${PROJECT_REF}.supabase.co/functions/v1/cloudbridge`;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
};

type AuthContext = {
  kind: "admin" | "device";
  token: string;
  device_id?: string;
};
type JsonRecord = Record<string, unknown>;
type FolderRow = {
  id: string;
  name: string;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
  trashed_at: string | null;
};
type FileRow = JsonRecord & {
  id: string;
  filename: string;
  storage_path: string;
  size: number;
  status: string;
  folder_id: string | null;
  pinned: boolean;
  expires_at: string;
  downloaded_at: string | null;
  trashed_at: string | null;
};

function getSecretKey(): string {
  const secretKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secretKeys) {
    try {
      const parsed = JSON.parse(secretKeys);
      if (parsed.default) return parsed.default;
    } catch {
      // Fall through to the legacy service-role secret.
    }
  }
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!legacy) {
    throw new Error("Missing Supabase secret key in Edge Function environment");
  }
  return legacy;
}

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, getSecretKey(), {
  auth: { persistSession: false },
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function text(
  body: string,
  status = 200,
  contentType = "text/plain; charset=utf-8",
): Response {
  return new Response(body, {
    status,
    headers: { ...corsHeaders, "Content-Type": contentType },
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

function addSeconds(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function beforeSeconds(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

function randomToken(bytes = 32): string {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array)).replaceAll("+", "-").replaceAll(
    "/",
    "_",
  ).replaceAll("=", "");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

function bearerToken(req: Request): string | null {
  const header = req.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

async function requireAuth(req: Request): Promise<AuthContext | Response> {
  const token = bearerToken(req);
  if (!token) return json({ detail: "Invalid or missing bearer token" }, 401);
  const tokenHash = await sha256(token);

  const { data: admins, error: adminError } = await supabase.from(
    "cloudbridge_admin_tokens",
  )
    .select("label").eq("token_hash", tokenHash).eq("revoked", false).limit(1);
  if (adminError) return json({ detail: adminError.message }, 500);
  if (admins?.length) return { kind: "admin", token };

  const { data: devices, error: deviceError } = await supabase.from(
    "cloudbridge_devices",
  )
    .select("device_id").eq("token_hash", tokenHash).eq("revoked", false).limit(
      1,
    );
  if (deviceError) return json({ detail: deviceError.message }, 500);
  if (devices?.length) {
    return { kind: "device", token, device_id: devices[0].device_id };
  }
  return json({ detail: "Invalid token" }, 401);
}

function normalizePath(url: URL): string {
  const path = url.pathname || "/";
  for (const prefix of ["/functions/v1/cloudbridge", "/cloudbridge"]) {
    if (path === prefix) return "/";
    if (path.startsWith(`${prefix}/`)) return path.slice(prefix.length) || "/";
  }
  return path;
}

function safeFilename(value: string): string {
  const cleaned = value.split(/[\\/]/).pop()?.replaceAll("\0", "").trim() ||
    "upload.bin";
  return cleaned.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").slice(0, 240) ||
    "upload.bin";
}

function safeFolderName(value: unknown): string {
  return String(value ?? "").replaceAll("\0", "").trim().replace(/[\\/]/g, "-")
    .slice(0, 120);
}

function publicFileRecord(record: JsonRecord): JsonRecord {
  const copy = { ...record };
  delete copy.storage_path;
  return copy;
}

function clampLimit(value: string | null): number {
  const parsed = Number(value ?? "50");
  if (!Number.isFinite(parsed)) return 50;
  return Math.max(1, Math.min(100, Math.trunc(parsed)));
}

function pinOwner(auth: AuthContext): string {
  return auth.device_id ?? "admin";
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value);
}

function folderDescendants(rootId: string, folders: FolderRow[]): string[] {
  const ids = new Set<string>([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of folders) {
      if (
        folder.parent_id && ids.has(folder.parent_id) && !ids.has(folder.id)
      ) {
        ids.add(folder.id);
        changed = true;
      }
    }
  }
  return [...ids];
}

function folderDepth(id: string, folders: FolderRow[]): number {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  let depth = 0;
  let current = byId.get(id);
  const seen = new Set<string>();
  while (current?.parent_id && !seen.has(current.id)) {
    seen.add(current.id);
    depth += 1;
    current = byId.get(current.parent_id);
  }
  return depth;
}

async function allFolders(): Promise<FolderRow[]> {
  const { data, error } = await supabase.from("cloudbridge_file_folders")
    .select("*").order("name");
  if (error) throw error;
  return (data ?? []) as FolderRow[];
}

async function activeFolder(folderId: unknown): Promise<FolderRow | null> {
  if (!isUuid(folderId)) return null;
  const { data, error } = await supabase.from("cloudbridge_file_folders")
    .select("*")
    .eq("id", folderId).is("trashed_at", null).maybeSingle();
  if (error) throw error;
  return data as FolderRow | null;
}

async function removeStoredFiles(rows: FileRow[]): Promise<void> {
  const paths = rows.map((row) => row.storage_path).filter(Boolean);
  for (let index = 0; index < paths.length; index += 1000) {
    const { error } = await supabase.storage.from(BUCKET).remove(
      paths.slice(index, index + 1000),
    );
    if (error) throw error;
  }
}

async function updateMaintenanceTimestamp(): Promise<void> {
  await supabase.from("cloudbridge_maintenance").upsert(
    { key: "cleanup", last_cleanup_at: nowIso(), updated_at: nowIso() },
    { onConflict: "key" },
  );
}

async function runCleanup(force = false): Promise<JsonRecord> {
  if (!force) {
    const { data } = await supabase.from("cloudbridge_maintenance").select(
      "last_cleanup_at",
    )
      .eq("key", "cleanup").maybeSingle();
    const lastCleanup = data?.last_cleanup_at
      ? new Date(data.last_cleanup_at).getTime()
      : 0;
    if (
      lastCleanup && Date.now() - lastCleanup < CLEANUP_INTERVAL_SECONDS * 1000
    ) {
      return {
        ran: false,
        reason: "recent",
        clipboard_deleted: 0,
        files_deleted: 0,
        folders_deleted: 0,
      };
    }
  }

  const { data: clipboardRows, error: clipboardError } = await supabase.from(
    "cloudbridge_clipboard",
  )
    .select("id").eq("pinned", false).lt(
      "created_at",
      beforeSeconds(CLIPBOARD_RETENTION_SECONDS),
    ).limit(500);
  if (clipboardError) throw clipboardError;
  const clipboardIds = (clipboardRows ?? []).map((row: { id: string }) =>
    row.id
  );
  if (clipboardIds.length) {
    const { error } = await supabase.from("cloudbridge_clipboard").delete().in(
      "id",
      clipboardIds,
    );
    if (error) throw error;
  }

  const { data: inboxRows, error: inboxError } = await supabase.from(
    "cloudbridge_files",
  )
    .select("*").eq("pinned", false).is("folder_id", null).is(
      "trashed_at",
      null,
    ).limit(500);
  if (inboxError) throw inboxError;
  const fileCutoff = new Date(beforeSeconds(FILE_CLEANUP_GRACE_SECONDS))
    .getTime();
  const expiredInbox = ((inboxRows ?? []) as FileRow[]).filter((row) => {
    const downloadedAt = row.downloaded_at
      ? new Date(row.downloaded_at).getTime()
      : 0;
    const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : 0;
    return (row.status === "downloaded" && downloadedAt > 0 &&
      downloadedAt < fileCutoff) ||
      (expiresAt > 0 && expiresAt < fileCutoff);
  });

  const { data: trashRows, error: trashError } = await supabase.from(
    "cloudbridge_files",
  )
    .select("*").not("trashed_at", "is", null).lt(
      "trashed_at",
      beforeSeconds(TRASH_RETENTION_SECONDS),
    ).limit(500);
  if (trashError) throw trashError;
  const purgeRows = [...expiredInbox, ...((trashRows ?? []) as FileRow[])];
  await removeStoredFiles(purgeRows);
  const fileIds = [...new Set(purgeRows.map((row) => row.id))];
  if (fileIds.length) {
    const { error } = await supabase.from("cloudbridge_files").delete().in(
      "id",
      fileIds,
    );
    if (error) throw error;
  }

  const folders = await allFolders();
  const trashCutoff = new Date(beforeSeconds(TRASH_RETENTION_SECONDS))
    .getTime();
  const expiredFolders = folders.filter((folder) =>
    folder.trashed_at && new Date(folder.trashed_at).getTime() < trashCutoff
  )
    .sort((a, b) => folderDepth(b.id, folders) - folderDepth(a.id, folders));
  let foldersDeleted = 0;
  for (const folder of expiredFolders) {
    const { count: fileCount } = await supabase.from("cloudbridge_files")
      .select("id", { count: "exact", head: true })
      .eq("folder_id", folder.id);
    if (fileCount) continue;
    const { count: childCount } = await supabase.from(
      "cloudbridge_file_folders",
    ).select("id", { count: "exact", head: true })
      .eq("parent_id", folder.id);
    if (childCount) continue;
    const { error } = await supabase.from("cloudbridge_file_folders").delete()
      .eq("id", folder.id);
    if (!error) foldersDeleted += 1;
  }

  await updateMaintenanceTimestamp();
  return {
    ran: true,
    clipboard_deleted: clipboardIds.length,
    files_deleted: fileIds.length,
    folders_deleted: foldersDeleted,
    completed_at: nowIso(),
  };
}

async function maybeCleanup(): Promise<void> {
  try {
    await runCleanup(false);
  } catch (error) {
    console.error("CloudBridge cleanup failed", error);
  }
}

async function restoreName(
  folder: FolderRow,
  folders: FolderRow[],
): Promise<string> {
  const siblingNames = new Set(
    folders.filter((item) =>
      item.id !== folder.id && item.parent_id === folder.parent_id &&
      !item.trashed_at
    )
      .map((item) => item.name.trim().toLowerCase()),
  );
  if (!siblingNames.has(folder.name.trim().toLowerCase())) return folder.name;
  const base = folder.name.replace(/ \(restored(?: \d+)?\)$/i, "").slice(
    0,
    105,
  );
  for (let index = 1; index < 1000; index += 1) {
    const suffix = index === 1 ? " (restored)" : ` (restored ${index})`;
    const candidate = `${base}${suffix}`.slice(0, 120);
    if (!siblingNames.has(candidate.toLowerCase())) return candidate;
  }
  return `${base.slice(0, 80)}-${crypto.randomUUID().slice(0, 8)}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  try {
    const url = new URL(req.url);
    const path = normalizePath(url);

    if (req.method === "GET" && path === "/health") {
      return json({ ok: true, service: APP_NAME, mode: "supabase-edge" });
    }
    if (req.method === "GET" && (path === "/" || path === "/app")) {
      return text(
        "CloudBridge API is online. Use the GitHub Pages PWA for the app.",
      );
    }

    if (req.method === "POST" && path === "/api/pairing/claim") {
      const body = await req.json();
      const codeHash = await sha256(String(body.code ?? ""));
      const { data: sessions, error: sessionError } = await supabase.from(
        "cloudbridge_pairing_sessions",
      )
        .select("*").eq("code_hash", codeHash).is("claimed_at", null).gt(
          "expires_at",
          nowIso(),
        ).limit(1);
      if (sessionError) return json({ detail: sessionError.message }, 500);
      if (!sessions?.length) {
        return json({ detail: "Pairing code is invalid or expired" }, 404);
      }
      const deviceId = String(body.device_id ?? "");
      if (!deviceId) return json({ detail: "device_id is required" }, 422);
      const token = randomToken(32);
      const tokenHash = await sha256(token);
      const platform = String(body.platform ?? "ios").slice(0, 40) || "ios";
      const { error: deviceError } = await supabase.from("cloudbridge_devices")
        .upsert(
          {
            device_id: deviceId,
            label: String(body.label ?? "iPhone").slice(0, 100),
            platform,
            token_hash: tokenHash,
            revoked: false,
          },
          { onConflict: "device_id" },
        );
      if (deviceError) return json({ detail: deviceError.message }, 500);
      const { error: claimError } = await supabase.from(
        "cloudbridge_pairing_sessions",
      )
        .update({ claimed_by_device_id: deviceId, claimed_at: nowIso() }).eq(
          "id",
          sessions[0].id,
        );
      if (claimError) return json({ detail: claimError.message }, 500);
      return json({ ok: true, device_id: deviceId, token });
    }

    const auth = await requireAuth(req);
    if (auth instanceof Response) return auth;

    if (req.method === "GET" && path === "/api/me") {
      return json({
        ok: true,
        auth: auth.kind,
        device_id: auth.device_id ?? null,
      });
    }

    if (req.method === "POST" && path === "/api/cleanup") {
      if (auth.kind !== "admin") {
        return json({ detail: "Admin token required" }, 401);
      }
      return json({ ok: true, cleanup: await runCleanup(true) });
    }

    if (req.method === "POST" && path === "/api/pairing/create") {
      if (auth.kind !== "admin") {
        return json({ detail: "Admin token required" }, 401);
      }
      const body = await req.json();
      const code = randomToken(18);
      const row = {
        code_hash: await sha256(code),
        created_by_device_id: String(body.device_id ?? "windows"),
        created_by_label: String(body.label ?? "Windows PC").slice(0, 100),
        expires_at: addSeconds(PAIRING_TTL_SECONDS),
      };
      const { data, error } = await supabase.from(
        "cloudbridge_pairing_sessions",
      ).insert(row).select("*").single();
      if (error) return json({ detail: error.message }, 500);
      await maybeCleanup();
      return json({
        ok: true,
        code,
        pairing_url: `${PUBLIC_BASE_URL}/app?code=${encodeURIComponent(code)}`,
        expires_at: data.expires_at,
      });
    }

    if (req.method === "POST" && path === "/api/clipboard/push") {
      const body = await req.json();
      if (!body.content || !body.device_id) {
        return json({ detail: "content and device_id are required" }, 422);
      }
      const { data, error } = await supabase.from("cloudbridge_clipboard")
        .insert({
          content: String(body.content),
          source: String(body.source ?? "unknown"),
          device_id: String(body.device_id),
        }).select("*").single();
      if (error) return json({ detail: error.message }, 500);
      await maybeCleanup();
      return json({ ok: true, item: data });
    }

    if (req.method === "GET" && path === "/api/clipboard/latest") {
      const { data, error } = await supabase.from("cloudbridge_clipboard")
        .select("*").order("version", { ascending: false }).limit(1);
      if (error) return json({ detail: error.message }, 500);
      const latest = data?.[0];
      if (
        !latest || url.searchParams.get("since_id") === latest.id ||
        url.searchParams.get("device_id") === latest.device_id
      ) {
        return json({ ok: true, has_update: false, item: null });
      }
      return json({ ok: true, has_update: true, item: latest });
    }

    if (req.method === "GET" && path === "/api/clipboard/history") {
      const limit = clampLimit(url.searchParams.get("limit"));
      let query = supabase.from("cloudbridge_clipboard")
        .select(
          "id,content,source,device_id,version,created_at,pinned,pinned_at,pinned_by_device_id",
        )
        .order("version", { ascending: false }).limit(limit);
      const pinned = url.searchParams.get("pinned");
      if (pinned === "true" || pinned === "false") {
        query = query.eq("pinned", pinned === "true");
      }
      const cursor = Number(url.searchParams.get("before_version"));
      if (Number.isFinite(cursor) && cursor > 0) {
        query = query.lt("version", cursor);
      }
      const { data, error } = await query;
      if (error) return json({ detail: error.message }, 500);
      const items = data ?? [];
      return json({
        ok: true,
        items,
        next_cursor: items.length === limit
          ? items[items.length - 1].version
          : null,
      });
    }

    const clipboardPinMatch = path.match(
      /^\/api\/clipboard\/([^/]+)\/(pin|unpin)$/,
    );
    if (req.method === "POST" && clipboardPinMatch) {
      const isPin = clipboardPinMatch[2] === "pin";
      const update = isPin
        ? {
          pinned: true,
          pinned_at: nowIso(),
          pinned_by_device_id: pinOwner(auth),
        }
        : { pinned: false, pinned_at: null, pinned_by_device_id: null };
      const { data, error } = await supabase.from("cloudbridge_clipboard")
        .update(update)
        .eq("id", clipboardPinMatch[1]).select("*").single();
      if (error) return json({ detail: error.message }, 500);
      return json({ ok: true, item: data });
    }

    if (req.method === "GET" && path === "/api/file-folders/tree") {
      const folders = (await allFolders()).filter((folder) =>
        !folder.trashed_at
      );
      return json({ ok: true, folders });
    }

    if (req.method === "POST" && path === "/api/file-folders") {
      const body = await req.json();
      const name = safeFolderName(body.name);
      if (!name) return json({ detail: "Folder name is required" }, 422);
      const parentId = body.parent_id || null;
      if (parentId && !await activeFolder(parentId)) {
        return json({ detail: "Parent folder not found" }, 404);
      }
      const { data, error } = await supabase.from("cloudbridge_file_folders")
        .insert({ name, parent_id: parentId }).select("*").single();
      if (error?.code === "23505") {
        return json(
          { detail: "A folder with this name already exists here" },
          409,
        );
      }
      if (error) return json({ detail: error.message }, 500);
      return json({ ok: true, folder: data }, 201);
    }

    const folderMatch = path.match(/^\/api\/file-folders\/([^/]+)$/);
    if (req.method === "PATCH" && folderMatch) {
      const folderId = folderMatch[1];
      const folders = await allFolders();
      const folder = folders.find((item) =>
        item.id === folderId && !item.trashed_at
      );
      if (!folder) return json({ detail: "Folder not found" }, 404);
      const body = await req.json();
      const update: JsonRecord = { updated_at: nowIso() };
      if (Object.hasOwn(body, "name")) {
        const name = safeFolderName(body.name);
        if (!name) return json({ detail: "Folder name is required" }, 422);
        update.name = name;
      }
      if (Object.hasOwn(body, "parent_id")) {
        const parentId = body.parent_id || null;
        if (parentId) {
          if (
            !isUuid(parentId) ||
            !folders.some((item) => item.id === parentId && !item.trashed_at)
          ) {
            return json({ detail: "Parent folder not found" }, 404);
          }
          if (folderDescendants(folderId, folders).includes(parentId)) {
            return json(
              { detail: "A folder cannot be moved into itself" },
              409,
            );
          }
        }
        update.parent_id = parentId;
      }
      const { data, error } = await supabase.from("cloudbridge_file_folders")
        .update(update).eq("id", folderId).select("*").single();
      if (error?.code === "23505") {
        return json(
          { detail: "A folder with this name already exists here" },
          409,
        );
      }
      if (error) return json({ detail: error.message }, 500);
      return json({ ok: true, folder: data });
    }

    const folderActionMatch = path.match(
      /^\/api\/file-folders\/([^/]+)\/(trash|restore)$/,
    );
    if (req.method === "POST" && folderActionMatch) {
      const folderId = folderActionMatch[1];
      const action = folderActionMatch[2];
      const folders = await allFolders();
      const folder = folders.find((item) => item.id === folderId);
      if (!folder) return json({ detail: "Folder not found" }, 404);
      const ids = folderDescendants(folderId, folders);
      if (action === "trash") {
        const stamp = nowIso();
        const { error: folderError } = await supabase.from(
          "cloudbridge_file_folders",
        ).update({ trashed_at: stamp, updated_at: stamp }).in("id", ids);
        if (folderError) return json({ detail: folderError.message }, 500);
        const { error: fileError } = await supabase.from("cloudbridge_files")
          .update({ trashed_at: stamp, updated_at: stamp })
          .in("folder_id", ids).is("trashed_at", null);
        if (fileError) return json({ detail: fileError.message }, 500);
      } else {
        const name = await restoreName(folder, folders);
        const stamp = nowIso();
        if (name !== folder.name) {
          const { error: renameError } = await supabase.from(
            "cloudbridge_file_folders",
          ).update({ name, updated_at: stamp }).eq("id", folderId);
          if (renameError) return json({ detail: renameError.message }, 500);
        }
        const { error: folderError } = await supabase.from(
          "cloudbridge_file_folders",
        ).update({ trashed_at: null, updated_at: stamp }).in("id", ids);
        if (folderError) return json({ detail: folderError.message }, 500);
        const { error: fileError } = await supabase.from("cloudbridge_files")
          .update({ trashed_at: null, updated_at: stamp })
          .in("folder_id", ids);
        if (fileError) return json({ detail: fileError.message }, 500);
      }
      return json({
        ok: true,
        folder_id: folderId,
        affected_folders: ids.length,
      });
    }

    if (req.method === "DELETE" && folderMatch) {
      const folderId = folderMatch[1];
      const folders = await allFolders();
      const folder = folders.find((item) =>
        item.id === folderId && item.trashed_at
      );
      if (!folder) {
        return json({
          detail: "Only trashed folders can be deleted permanently",
        }, 409);
      }
      const ids = folderDescendants(folderId, folders);
      const { data: files, error: fileError } = await supabase.from(
        "cloudbridge_files",
      ).select("*").in("folder_id", ids);
      if (fileError) return json({ detail: fileError.message }, 500);
      await removeStoredFiles((files ?? []) as FileRow[]);
      if (files?.length) {
        const { error } = await supabase.from("cloudbridge_files").delete().in(
          "id",
          files.map((item: { id: string }) => item.id),
        );
        if (error) return json({ detail: error.message }, 500);
      }
      const ordered = ids.sort((a, b) =>
        folderDepth(b, folders) - folderDepth(a, folders)
      );
      for (const id of ordered) {
        const { error } = await supabase.from("cloudbridge_file_folders")
          .delete().eq("id", id);
        if (error) return json({ detail: error.message }, 500);
      }
      return json({
        ok: true,
        deleted_files: files?.length ?? 0,
        deleted_folders: ids.length,
      });
    }

    if (req.method === "POST" && path === "/api/files/upload") {
      const form = await req.formData();
      const uploaded = form.get("file");
      if (!(uploaded instanceof File)) {
        return json({ detail: "file is required" }, 422);
      }
      const requestedFolder = String(form.get("folder_id") ?? "");
      const folderId = requestedFolder && requestedFolder !== "inbox"
        ? requestedFolder
        : null;
      if (folderId && !await activeFolder(folderId)) {
        return json({ detail: "Folder not found" }, 404);
      }
      const fileId = crypto.randomUUID();
      const filename = safeFilename(uploaded.name || "upload.bin");
      const storagePath = `${fileId}/${filename}`;
      const bytes = new Uint8Array(await uploaded.arrayBuffer());
      const { error: uploadError } = await supabase.storage.from(BUCKET).upload(
        storagePath,
        bytes,
        {
          contentType: uploaded.type || "application/octet-stream",
          upsert: false,
        },
      );
      if (uploadError) return json({ detail: uploadError.message }, 500);
      const row = {
        id: fileId,
        filename,
        storage_path: storagePath,
        size: bytes.length,
        mime_type: uploaded.type || "application/octet-stream",
        source: String(form.get("source") ?? "unknown"),
        device_id: String(form.get("device_id") ?? ""),
        status: "pending",
        expires_at: addSeconds(FILE_TTL_SECONDS),
        folder_id: folderId,
      };
      const { data, error } = await supabase.from("cloudbridge_files").insert(
        row,
      ).select("*").single();
      if (error) {
        await supabase.storage.from(BUCKET).remove([storagePath]);
        return json({ detail: error.message }, 500);
      }
      await maybeCleanup();
      return json({ ok: true, item: publicFileRecord(data) });
    }

    if (req.method === "GET" && path === "/api/files/pending") {
      const deviceId = url.searchParams.get("device_id");
      let query = supabase.from("cloudbridge_files").select("*").eq(
        "status",
        "pending",
      )
        .is("trashed_at", null)
        .or(`folder_id.not.is.null,pinned.eq.true,expires_at.gt.${nowIso()}`)
        .order("uploaded_at", { ascending: true });
      if (deviceId) query = query.neq("device_id", deviceId);
      const { data, error } = await query;
      if (error) return json({ detail: error.message }, 500);
      return json({ ok: true, items: (data ?? []).map(publicFileRecord) });
    }

    if (req.method === "GET" && path === "/api/files/history") {
      const { data, error } = await supabase.from("cloudbridge_files").select(
        "*",
      ).is("trashed_at", null)
        .order("pinned", { ascending: false }).order("uploaded_at", {
          ascending: false,
        }).limit(clampLimit(url.searchParams.get("limit")));
      if (error) return json({ detail: error.message }, 500);
      return json({ ok: true, items: (data ?? []).map(publicFileRecord) });
    }

    if (req.method === "GET" && path === "/api/files/browse") {
      const location = url.searchParams.get("folder_id") ?? "root";
      const limit = clampLimit(url.searchParams.get("limit"));
      const folders = (await allFolders()).filter((folder) =>
        !folder.trashed_at
      );
      if (location === "root") {
        const { count } = await supabase.from("cloudbridge_files").select(
          "id",
          { count: "exact", head: true },
        )
          .is("folder_id", null).is("trashed_at", null);
        return json({
          ok: true,
          location,
          folders: folders.filter((folder) => !folder.parent_id),
          files: [],
          inbox_count: count ?? 0,
        });
      }
      const folderId = location === "inbox" ? null : location;
      if (folderId && !folders.some((folder) => folder.id === folderId)) {
        return json({ detail: "Folder not found" }, 404);
      }
      const sortMap: Record<string, string> = {
        name: "filename",
        newest: "uploaded_at",
        oldest: "uploaded_at",
        size: "size",
      };
      const sort = url.searchParams.get("sort") ?? "newest";
      const column = sortMap[sort] ?? "uploaded_at";
      const ascending = sort === "oldest" || sort === "name";
      let fileQuery = supabase.from("cloudbridge_files").select("*").is(
        "trashed_at",
        null,
      )
        .order(column, { ascending }).limit(limit);
      fileQuery = folderId
        ? fileQuery.eq("folder_id", folderId)
        : fileQuery.is("folder_id", null);
      const { data, error } = await fileQuery;
      if (error) return json({ detail: error.message }, 500);
      return json({
        ok: true,
        location,
        folders: folderId
          ? folders.filter((folder) => folder.parent_id === folderId)
          : [],
        files: (data ?? []).map(publicFileRecord),
      });
    }

    if (req.method === "GET" && path === "/api/files/search") {
      const q = String(url.searchParams.get("q") ?? "").trim().slice(0, 100);
      if (q.length < 2) return json({ ok: true, folders: [], files: [] });
      const pattern = `%${q.replaceAll("%", "").replaceAll("_", "")}%`;
      const { data: folders, error: folderError } = await supabase.from(
        "cloudbridge_file_folders",
      ).select("*")
        .is("trashed_at", null).ilike("name", pattern).order("name").limit(50);
      if (folderError) return json({ detail: folderError.message }, 500);
      const { data: files, error: fileError } = await supabase.from(
        "cloudbridge_files",
      ).select("*")
        .is("trashed_at", null).ilike("filename", pattern).order(
          "uploaded_at",
          { ascending: false },
        ).limit(100);
      if (fileError) return json({ detail: fileError.message }, 500);
      return json({
        ok: true,
        folders: folders ?? [],
        files: (files ?? []).map(publicFileRecord),
      });
    }

    if (req.method === "GET" && path === "/api/files/trash") {
      const folders = await allFolders();
      const trashedFolders = folders.filter((folder) => folder.trashed_at);
      const trashedIds = new Set(trashedFolders.map((folder) => folder.id));
      const roots = trashedFolders.filter((folder) =>
        !folder.parent_id || !trashedIds.has(folder.parent_id)
      );
      const { data: files, error } = await supabase.from("cloudbridge_files")
        .select("*").not("trashed_at", "is", null)
        .order("trashed_at", { ascending: false }).limit(100);
      if (error) return json({ detail: error.message }, 500);
      const standalone = ((files ?? []) as FileRow[]).filter((file) =>
        !file.folder_id || !trashedIds.has(file.folder_id)
      );
      return json({
        ok: true,
        folders: roots,
        files: standalone.map(publicFileRecord),
        retention_seconds: TRASH_RETENTION_SECONDS,
      });
    }

    if (req.method === "GET" && path === "/api/files/storage") {
      const { data, error } = await supabase.from("cloudbridge_files").select(
        "size",
      );
      if (error) return json({ detail: error.message }, 500);
      const used = (data ?? []).reduce(
        (total: number, row: { size: number | null }) =>
          total + Number(row.size || 0),
        0,
      );
      return json({
        ok: true,
        used_bytes: used,
        quota_bytes: STORAGE_QUOTA_BYTES,
        usage_ratio: STORAGE_QUOTA_BYTES ? used / STORAGE_QUOTA_BYTES : 0,
      });
    }

    if (req.method === "POST" && path === "/api/files/bulk") {
      const body = await req.json();
      const ids = [
        ...new Set(Array.isArray(body.ids) ? body.ids.filter(isUuid) : []),
      ] as string[];
      if (!ids.length || ids.length > 100) {
        return json({ detail: "Choose between 1 and 100 valid files" }, 422);
      }
      const action = String(body.action ?? "");
      const { data: rows, error: selectError } = await supabase.from(
        "cloudbridge_files",
      ).select("*").in("id", ids);
      if (selectError) return json({ detail: selectError.message }, 500);
      const files = (rows ?? []) as FileRow[];
      if (files.length !== ids.length) {
        return json({ detail: "One or more files were not found" }, 404);
      }
      const stamp = nowIso();

      if (action === "move") {
        const requested = body.folder_id || null;
        const folderId = requested === "inbox" ? null : requested;
        if (folderId && !await activeFolder(folderId)) {
          return json({ detail: "Folder not found" }, 404);
        }
        const update: JsonRecord = { folder_id: folderId, updated_at: stamp };
        if (!folderId) update.expires_at = addSeconds(FILE_TTL_SECONDS);
        const { error } = await supabase.from("cloudbridge_files").update(
          update,
        ).in("id", ids).is("trashed_at", null);
        if (error) return json({ detail: error.message }, 500);
        if (!folderId) {
          const downloaded = files.filter((file) =>
            file.status === "downloaded"
          ).map((file) => file.id);
          if (downloaded.length) {
            await supabase.from("cloudbridge_files").update({
              downloaded_at: stamp,
            }).in("id", downloaded);
          }
        }
      } else if (action === "pin" || action === "unpin") {
        const isPin = action === "pin";
        const { error } = await supabase.from("cloudbridge_files").update(
          isPin
            ? {
              pinned: true,
              pinned_at: stamp,
              pinned_by_device_id: pinOwner(auth),
              updated_at: stamp,
            }
            : {
              pinned: false,
              pinned_at: null,
              pinned_by_device_id: null,
              updated_at: stamp,
            },
        ).in("id", ids);
        if (error) return json({ detail: error.message }, 500);
      } else if (action === "trash") {
        const groups = new Map<string, string[]>();
        for (const file of files) {
          const key = file.folder_id ?? "inbox";
          groups.set(key, [...(groups.get(key) ?? []), file.id]);
        }
        for (const [key, groupIds] of groups) {
          const { error } = await supabase.from("cloudbridge_files").update({
            trashed_at: stamp,
            trashed_from_folder_id: key === "inbox" ? null : key,
            updated_at: stamp,
          }).in("id", groupIds).is("trashed_at", null);
          if (error) return json({ detail: error.message }, 500);
        }
      } else if (action === "restore") {
        for (const file of files) {
          let folderId = file.trashed_from_folder_id as string | null ??
            file.folder_id;
          if (folderId && !await activeFolder(folderId)) folderId = null;
          const update: JsonRecord = {
            trashed_at: null,
            trashed_from_folder_id: null,
            folder_id: folderId,
            updated_at: stamp,
          };
          if (!folderId) update.expires_at = addSeconds(FILE_TTL_SECONDS);
          const { error } = await supabase.from("cloudbridge_files").update(
            update,
          ).eq("id", file.id);
          if (error) return json({ detail: error.message }, 500);
        }
      } else if (action === "delete_permanently") {
        if (files.some((file) => !file.trashed_at)) {
          return json({
            detail: "Only trashed files can be deleted permanently",
          }, 409);
        }
        await removeStoredFiles(files);
        const { error } = await supabase.from("cloudbridge_files").delete().in(
          "id",
          ids,
        );
        if (error) return json({ detail: error.message }, 500);
      } else {
        return json({ detail: "Unsupported bulk action" }, 422);
      }
      await maybeCleanup();
      return json({ ok: true, action, affected: ids.length });
    }

    const fileMatch = path.match(/^\/api\/files\/([^/]+)$/);
    if (req.method === "PATCH" && fileMatch) {
      const body = await req.json();
      const rawFilename = String(body.filename ?? "").trim();
      if (!rawFilename) return json({ detail: "Filename is required" }, 422);
      const filename = safeFilename(rawFilename);
      const { data, error } = await supabase.from("cloudbridge_files").update({
        filename,
        updated_at: nowIso(),
      })
        .eq("id", fileMatch[1]).is("trashed_at", null).select("*").single();
      if (error) return json({ detail: error.message }, 500);
      return json({ ok: true, item: publicFileRecord(data) });
    }

    const fileDownloadMatch = path.match(/^\/api\/files\/([^/]+)\/download$/);
    if (req.method === "GET" && fileDownloadMatch) {
      const { data: record, error } = await supabase.from("cloudbridge_files")
        .select("*").eq("id", fileDownloadMatch[1]).single();
      if (error || !record || record.trashed_at) {
        return json({ detail: "File not found" }, 404);
      }
      if (
        !record.pinned && !record.folder_id &&
        new Date(record.expires_at).getTime() <= Date.now()
      ) {
        return json({ detail: "File expired" }, 410);
      }
      const { data, error: downloadError } = await supabase.storage.from(BUCKET)
        .download(record.storage_path);
      if (downloadError || !data) {
        return json({
          detail: downloadError?.message ?? "File payload not found",
        }, 410);
      }
      return new Response(data, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": record.mime_type,
          "Content-Disposition": `attachment; filename="${
            String(record.filename).replaceAll('"', "")
          }"`,
        },
      });
    }

    const fileAckMatch = path.match(/^\/api\/files\/([^/]+)\/ack$/);
    if (req.method === "POST" && fileAckMatch) {
      const { data, error } = await supabase.from("cloudbridge_files").update({
        status: "downloaded",
        downloaded_at: nowIso(),
        updated_at: nowIso(),
      })
        .eq("id", fileAckMatch[1]).is("trashed_at", null).select("*").single();
      if (error) return json({ detail: error.message }, 500);
      await maybeCleanup();
      return json({ ok: true, item: publicFileRecord(data) });
    }

    const filePinMatch = path.match(/^\/api\/files\/([^/]+)\/(pin|unpin)$/);
    if (req.method === "POST" && filePinMatch) {
      const isPin = filePinMatch[2] === "pin";
      const update = isPin
        ? {
          pinned: true,
          pinned_at: nowIso(),
          pinned_by_device_id: pinOwner(auth),
          updated_at: nowIso(),
        }
        : {
          pinned: false,
          pinned_at: null,
          pinned_by_device_id: null,
          updated_at: nowIso(),
        };
      const { data, error } = await supabase.from("cloudbridge_files").update(
        update,
      ).eq("id", filePinMatch[1]).select("*").single();
      if (error) return json({ detail: error.message }, 500);
      return json({ ok: true, item: publicFileRecord(data) });
    }

    return json({ detail: "Not found" }, 404);
  } catch (error) {
    return json({
      detail: error instanceof Error ? error.message : String(error),
    }, 500);
  }
});
