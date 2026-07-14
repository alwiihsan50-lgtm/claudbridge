create table if not exists public.cloudbridge_file_folders (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  parent_id uuid references public.cloudbridge_file_folders(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  trashed_at timestamptz,
  constraint cloudbridge_file_folders_name_check
    check (char_length(btrim(name)) between 1 and 120),
  constraint cloudbridge_file_folders_not_self_parent
    check (parent_id is null or parent_id <> id)
);

alter table public.cloudbridge_file_folders enable row level security;

alter table public.cloudbridge_files
  add column if not exists folder_id uuid
    references public.cloudbridge_file_folders(id) on delete restrict,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists trashed_at timestamptz,
  add column if not exists trashed_from_folder_id uuid
    references public.cloudbridge_file_folders(id) on delete set null;

create unique index if not exists cloudbridge_file_folders_active_name_idx
  on public.cloudbridge_file_folders (
    coalesce(parent_id::text, 'root'),
    lower(btrim(name))
  )
  where trashed_at is null;

create index if not exists cloudbridge_file_folders_parent_idx
  on public.cloudbridge_file_folders (parent_id, name)
  where trashed_at is null;

create index if not exists cloudbridge_file_folders_trash_idx
  on public.cloudbridge_file_folders (trashed_at)
  where trashed_at is not null;

create index if not exists cloudbridge_files_folder_idx
  on public.cloudbridge_files (folder_id, uploaded_at desc)
  where trashed_at is null;

create index if not exists cloudbridge_files_name_search_idx
  on public.cloudbridge_files (lower(filename) text_pattern_ops)
  where trashed_at is null;

create index if not exists cloudbridge_files_trash_idx
  on public.cloudbridge_files (trashed_at)
  where trashed_at is not null;

create index if not exists cloudbridge_files_trashed_from_folder_idx
  on public.cloudbridge_files (trashed_from_folder_id)
  where trashed_from_folder_id is not null;
