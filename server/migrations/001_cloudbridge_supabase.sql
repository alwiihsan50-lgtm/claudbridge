create extension if not exists pgcrypto;

create table if not exists public.cloudbridge_devices (
  device_id text primary key,
  label text not null default 'Device',
  platform text not null default 'unknown',
  token_hash text not null unique,
  revoked boolean not null default false,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);

create table if not exists public.cloudbridge_pairing_sessions (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique,
  created_by_device_id text not null,
  created_by_label text not null default 'Windows PC',
  claimed_by_device_id text,
  expires_at timestamptz not null,
  claimed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.cloudbridge_clipboard (
  id uuid primary key default gen_random_uuid(),
  content text not null,
  source text not null default 'unknown',
  device_id text not null,
  version bigint generated always as identity,
  created_at timestamptz not null default now()
);

create index if not exists cloudbridge_clipboard_latest_idx on public.cloudbridge_clipboard (version desc);
create index if not exists cloudbridge_clipboard_device_idx on public.cloudbridge_clipboard (device_id);

create table if not exists public.cloudbridge_files (
  id uuid primary key default gen_random_uuid(),
  filename text not null,
  storage_path text not null unique,
  size bigint not null default 0,
  mime_type text not null default 'application/octet-stream',
  source text not null default 'unknown',
  device_id text not null,
  status text not null default 'pending' check (status in ('pending', 'downloaded', 'expired')),
  uploaded_at timestamptz not null default now(),
  downloaded_at timestamptz,
  expires_at timestamptz not null
);

create index if not exists cloudbridge_files_pending_idx on public.cloudbridge_files (status, uploaded_at);
create index if not exists cloudbridge_files_expires_idx on public.cloudbridge_files (expires_at);

alter table public.cloudbridge_devices enable row level security;
alter table public.cloudbridge_pairing_sessions enable row level security;
alter table public.cloudbridge_clipboard enable row level security;
alter table public.cloudbridge_files enable row level security;

-- The FastAPI backend uses SUPABASE_SERVICE_ROLE_KEY server-side.
-- No anon/authenticated policies are added, so browser clients cannot access these tables directly.

insert into storage.buckets (id, name, public, file_size_limit)
values ('cloudbridge-files', 'cloudbridge-files', false, 104857600)
on conflict (id) do nothing;


