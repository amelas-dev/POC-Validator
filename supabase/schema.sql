-- Lane — Supabase schema, Row-Level Security, and Storage policies.
-- Paste this whole file into the Supabase SQL Editor and run it once.
--
-- What it sets up:
--   • checks          — the history/audit record per triage (metadata only, no code)
--   • library_assets  — metadata for each saved file (the file bytes live in Storage)
--   • lane-library    — a PRIVATE Storage bucket holding the file bytes, foldered per user
--
-- Every table and the bucket are guarded by RLS so a signed-in account can only ever
-- read or write its own rows / files. Auth itself (email signup/login) is built into
-- Supabase — no schema needed for it; auth.uid() below is the signed-in user's id.

-- ---------------------------------------------------------------------------
-- 1. checks — replaces the localStorage "recents" list
-- ---------------------------------------------------------------------------
create table if not exists public.checks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  slug        text not null,           -- short label for the checked tool
  source      text,                    -- e.g. github url / "uploaded files" / spreadsheet name
  verdict     text not null,           -- lane key: ready / developer / signoff
  confidence  text default 'high'      -- high / medium / low
);

create index if not exists checks_user_created_idx
  on public.checks (user_id, created_at desc);

alter table public.checks enable row level security;

-- Owner-only access. Split per-command so each is explicit.
drop policy if exists "checks_select_own" on public.checks;
create policy "checks_select_own" on public.checks
  for select using (auth.uid() = user_id);

drop policy if exists "checks_insert_own" on public.checks;
create policy "checks_insert_own" on public.checks
  for insert with check (auth.uid() = user_id);

drop policy if exists "checks_update_own" on public.checks;
create policy "checks_update_own" on public.checks
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "checks_delete_own" on public.checks;
create policy "checks_delete_own" on public.checks
  for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 2. library_assets — replaces the IndexedDB asset records
--    (the actual bytes are in the Storage bucket below; this row points at them)
-- ---------------------------------------------------------------------------
create table if not exists public.library_assets (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at    timestamptz not null default now(),
  name          text not null,         -- original filename
  content_type  text,                  -- mime type
  size_bytes    bigint,
  storage_path  text not null,         -- path within the lane-library bucket
  verdict       text,                  -- lane key carried from the check: ready / developer / signoff
  source        text,                  -- e.g. github url / "uploaded files" / spreadsheet name
  file_count    integer                -- how many files made up the saved asset
);

-- Migration for EXISTING projects (created before verdict/source/file_count were
-- added). Safe to run repeatedly — each column is only added if it's missing.
-- created_at already existed on the original table, so it's included for
-- completeness but is a no-op there.
alter table public.library_assets add column if not exists verdict      text;
alter table public.library_assets add column if not exists source       text;
alter table public.library_assets add column if not exists file_count   integer;
alter table public.library_assets add column if not exists created_at    timestamptz not null default now();

create index if not exists library_assets_user_created_idx
  on public.library_assets (user_id, created_at desc);

alter table public.library_assets enable row level security;

drop policy if exists "assets_select_own" on public.library_assets;
create policy "assets_select_own" on public.library_assets
  for select using (auth.uid() = user_id);

drop policy if exists "assets_insert_own" on public.library_assets;
create policy "assets_insert_own" on public.library_assets
  for insert with check (auth.uid() = user_id);

drop policy if exists "assets_delete_own" on public.library_assets;
create policy "assets_delete_own" on public.library_assets
  for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 3. Storage bucket for the file bytes — PRIVATE, owner-only
--    Convention: every object is stored under "<user_id>/<asset_id>/<filename>"
--    so the first path segment is the owner's uid; the policies enforce that.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('lane-library', 'lane-library', false)
on conflict (id) do nothing;

drop policy if exists "lane_library_select_own" on storage.objects;
create policy "lane_library_select_own" on storage.objects
  for select using (
    bucket_id = 'lane-library'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "lane_library_insert_own" on storage.objects;
create policy "lane_library_insert_own" on storage.objects
  for insert with check (
    bucket_id = 'lane-library'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "lane_library_delete_own" on storage.objects;
create policy "lane_library_delete_own" on storage.objects
  for delete using (
    bucket_id = 'lane-library'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
