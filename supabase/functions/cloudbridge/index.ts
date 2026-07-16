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
const CLEANUP_INTERVAL_SECONDS = Number(
  Deno.env.get("CLOUD_BRIDGE_CLEANUP_INTERVAL_SECONDS") ?? "86400",
);
const QUICK_CLIPBOARD_MAX_BYTES = 1024 * 1024;
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
  access_scope: "full" | "clipboard_quick";
  parent_device_id?: string | null;
};
type JsonRecord = Record<string, unknown>;
type FileRow = JsonRecord & {
  id: string;
  filename: string;
  storage_path: string;
  size: number;
  status: string;
  pinned: boolean;
  expires_at: string;
  downloaded_at: string | null;
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
  if (admins?.length) return { kind: "admin", token, access_scope: "full" };

  const { data: devices, error: deviceError } = await supabase.from(
    "cloudbridge_devices",
  )
    .select("device_id,access_scope,parent_device_id").eq(
      "token_hash",
      tokenHash,
    ).eq("revoked", false).limit(1);
  if (deviceError) return json({ detail: deviceError.message }, 500);
  if (devices?.length) {
    return {
      kind: "device",
      token,
      device_id: devices[0].device_id,
      access_scope: devices[0].access_scope ?? "full",
      parent_device_id: devices[0].parent_device_id,
    };
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

function publicFileRecord(record: JsonRecord): JsonRecord {
  const copy = { ...record };
  delete copy.storage_path;
  delete copy.folder_id;
  delete copy.trashed_at;
  delete copy.trashed_from_folder_id;
  return copy;
}

function clampLimit(value: string | null): number {
  const parsed = Number(value ?? "50");
  if (!Number.isFinite(parsed)) return 50;
  return Math.max(1, Math.min(100, Math.trunc(parsed)));
}

function publishableKey(): string | null {
  const keys = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  if (keys) {
    try {
      return JSON.parse(keys).default ?? null;
    } catch {
      // Fall through to the legacy anon key.
    }
  }
  return Deno.env.get("SUPABASE_ANON_KEY") ?? null;
}

async function broadcastChange(kind: string, item: JsonRecord): Promise<void> {
  const key = publishableKey();
  if (!key) return;
  try {
    await fetch(`${Deno.env.get("SUPABASE_URL")}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { apikey: key, "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{
          topic: "cloudbridge",
          event: "cloudbridge_change",
          payload: { kind, ...item },
        }],
      }),
    });
  } catch {
    // Polling remains the fallback when Realtime is unavailable.
  }
}

function pinOwner(auth: AuthContext): string {
  return auth.device_id ?? "admin";
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

  const { data: temporaryRows, error: temporaryError } = await supabase.from(
    "cloudbridge_files",
  )
    .select("*").eq("pinned", false).limit(500);
  if (temporaryError) throw temporaryError;
  const fileCutoff = new Date(beforeSeconds(FILE_CLEANUP_GRACE_SECONDS))
    .getTime();
  const expiredFiles = ((temporaryRows ?? []) as FileRow[]).filter((row) => {
    const downloadedAt = row.downloaded_at
      ? new Date(row.downloaded_at).getTime()
      : 0;
    const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : 0;
    return (row.status === "downloaded" && downloadedAt > 0 &&
      downloadedAt < fileCutoff) ||
      (expiresAt > 0 && expiresAt < fileCutoff);
  });
  await removeStoredFiles(expiredFiles);
  const fileIds = expiredFiles.map((row) => row.id);
  if (fileIds.length) {
    const { error } = await supabase.from("cloudbridge_files").delete().in(
      "id",
      fileIds,
    );
    if (error) throw error;
  }

  await updateMaintenanceTimestamp();
  return {
    ran: true,
    clipboard_deleted: clipboardIds.length,
    files_deleted: fileIds.length,
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
        access_scope: auth.access_scope,
      });
    }

    if (path === "/api/quick-actions/setup") {
      if (auth.kind !== "device" || auth.access_scope !== "full") {
        return json({ detail: "Full device token required" }, 403);
      }
      const parentDeviceId = auth.device_id!;
      if (req.method === "POST") {
        const token = randomToken(32);
        const quickDeviceId = `${parentDeviceId}:quick`;
        const { error } = await supabase.from("cloudbridge_devices").upsert({
          device_id: quickDeviceId,
          label: "iPhone Quick Actions",
          platform: "ios-shortcuts",
          token_hash: await sha256(token),
          revoked: false,
          access_scope: "clipboard_quick",
          parent_device_id: parentDeviceId,
          last_seen_at: null,
        }, { onConflict: "device_id" });
        if (error) return json({ detail: error.message }, 500);
        return json({
          ok: true,
          device_id: quickDeviceId,
          token,
          push_url: `${PUBLIC_BASE_URL}/api/quick/clipboard/push`,
          pull_url: `${PUBLIC_BASE_URL}/api/quick/clipboard/pull`,
        });
      }
      if (req.method === "DELETE") {
        const { error } = await supabase.from("cloudbridge_devices").update({
          revoked: true,
        }).eq("parent_device_id", parentDeviceId).eq(
          "access_scope",
          "clipboard_quick",
        );
        if (error) return json({ detail: error.message }, 500);
        return json({ ok: true });
      }
    }

    if (req.method === "POST" && path === "/api/quick/clipboard/push") {
      if (auth.access_scope !== "clipboard_quick" || !auth.device_id) {
        return json({ detail: "Quick Actions token required" }, 403);
      }
      const contentType = req.headers.get("content-type")?.toLowerCase() ?? "";
      let content = "";
      if (contentType.includes("application/json")) {
        const body = await req.json();
        content = String(body.content ?? "");
      } else if (
        contentType.includes("multipart/form-data") ||
        contentType.includes("application/x-www-form-urlencoded")
      ) {
        const form = await req.formData();
        content = String(form.get("content") ?? "");
      } else {
        // iOS Shortcuts sends its File request body as raw text.
        content = await req.text();
      }
      const byteLength = new TextEncoder().encode(content).byteLength;
      if (!content.length) return json({ detail: "Clipboard is empty" }, 422);
      if (byteLength > QUICK_CLIPBOARD_MAX_BYTES) {
        return json({ detail: "Clipboard exceeds 1 MB" }, 413);
      }
      const { data, error } = await supabase.from("cloudbridge_clipboard")
        .insert({
          content,
          source: "ios-shortcut",
          device_id: auth.device_id,
        }).select("*").single();
      if (error) return json({ detail: error.message }, 500);
      await Promise.all([
        maybeCleanup(),
        broadcastChange("clipboard", {
          id: data.id,
          device_id: auth.device_id,
          source: "ios-shortcut",
        }),
        supabase.from("cloudbridge_devices").update({ last_seen_at: nowIso() })
          .eq("device_id", auth.device_id),
      ]);
      return json({ ok: true, message: "Sent" });
    }

    if (req.method === "GET" && path === "/api/quick/clipboard/pull") {
      if (auth.access_scope !== "clipboard_quick" || !auth.device_id) {
        return json({ detail: "Quick Actions token required" }, 403);
      }
      const { data, error } = await supabase.from("cloudbridge_clipboard")
        .select("content").neq("device_id", auth.device_id)
        .order("version", { ascending: false }).limit(1);
      if (error) return json({ detail: error.message }, 500);
      await supabase.from("cloudbridge_devices").update({
        last_seen_at: nowIso(),
      }).eq("device_id", auth.device_id);
      if (!data?.length) {
        return new Response(null, { status: 204, headers: corsHeaders });
      }
      return text(String(data[0].content));
    }

    if (auth.access_scope === "clipboard_quick") {
      return json(
        { detail: "Quick Actions token cannot access this endpoint" },
        403,
      );
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

    if (req.method === "POST" && path === "/api/files/upload") {
      const form = await req.formData();
      const uploaded = form.get("file");
      if (!(uploaded instanceof File)) {
        return json({ detail: "file is required" }, 422);
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
        .or(`pinned.eq.true,expires_at.gt.${nowIso()}`)
        .order("uploaded_at", { ascending: true });
      if (deviceId) query = query.neq("device_id", deviceId);
      const { data, error } = await query;
      if (error) return json({ detail: error.message }, 500);
      return json({ ok: true, items: (data ?? []).map(publicFileRecord) });
    }

    if (req.method === "GET" && path === "/api/files/history") {
      const limit = clampLimit(url.searchParams.get("limit"));
      let query = supabase.from("cloudbridge_files").select("*")
        .order("uploaded_at", { ascending: false }).limit(limit);
      const pinned = url.searchParams.get("pinned");
      if (pinned === "true" || pinned === "false") {
        query = query.eq("pinned", pinned === "true");
      }
      const cursor = url.searchParams.get("before_uploaded_at");
      if (cursor && !Number.isNaN(Date.parse(cursor))) {
        query = query.lt("uploaded_at", cursor);
      }
      const { data, error } = await query;
      if (error) return json({ detail: error.message }, 500);
      const items = (data ?? []).map(publicFileRecord);
      return json({
        ok: true,
        items,
        next_cursor: items.length === limit
          ? String(items[items.length - 1].uploaded_at)
          : null,
      });
    }

    const fileDownloadMatch = path.match(/^\/api\/files\/([^/]+)\/download$/);
    if (req.method === "GET" && fileDownloadMatch) {
      const { data: record, error } = await supabase.from("cloudbridge_files")
        .select("*").eq("id", fileDownloadMatch[1]).single();
      if (error || !record) {
        return json({ detail: "File not found" }, 404);
      }
      if (
        !record.pinned && new Date(record.expires_at).getTime() <= Date.now()
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
          "Content-Disposition": `inline; filename="${
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
      }).eq("id", fileAckMatch[1]).select("*").single();
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
