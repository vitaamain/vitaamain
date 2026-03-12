-- ═══════════════════════════════════════════════════════════════
-- VitaaMain — Supabase SQL Schema
-- Run this in your Supabase project: SQL Editor → New Query → Run
-- ═══════════════════════════════════════════════════════════════

-- Enable UUID generation
create extension if not exists "pgcrypto";

-- ─────────────────────────────────────────────────────────────
-- 1. PROFILES
--    One row per user. Auto-created on signup via trigger or
--    manually from the auth function.
-- ─────────────────────────────────────────────────────────────
create table if not exists profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  full_name   text,
  avatar_url  text,
  created_at  timestamptz default now()
);

alter table profiles enable row level security;

create policy "Users can read own profile"
  on profiles for select using (auth.uid() = id);

create policy "Users can update own profile"
  on profiles for update using (auth.uid() = id);

-- ─────────────────────────────────────────────────────────────
-- 2. PLATFORM CONNECTIONS
--    Stores OAuth tokens / stream keys per user per platform.
--    stream_key and access_token should be encrypted at rest
--    using pgcrypto in a production environment.
-- ─────────────────────────────────────────────────────────────
create table if not exists platform_connections (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  platform     text not null check (platform in ('twitch','youtube','kick','tiktok','facebook')),
  stream_key   text,                -- RTMP stream key (store encrypted)
  access_token text,                -- OAuth access token (store encrypted)
  refresh_token text,               -- OAuth refresh token
  channel_name text,                -- e.g. "xXShadowGamer"
  channel_id   text,                -- platform-specific channel/user ID
  connected_at timestamptz default now(),
  unique (user_id, platform)
);

alter table platform_connections enable row level security;

create policy "Users can manage own platform connections"
  on platform_connections for all using (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────
-- 3. STREAM SESSIONS
--    Records each stream session with metadata and end-of-stream stats.
-- ─────────────────────────────────────────────────────────────
create table if not exists stream_sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  title         text,
  scene         text,
  platforms     text[],                    -- array of platform ids
  status        text default 'active' check (status in ('active','ended')),
  started_at    timestamptz default now(),
  ended_at      timestamptz,
  peak_viewers  integer default 0,
  total_follows integer default 0,
  total_subs    integer default 0
);

alter table stream_sessions enable row level security;

create policy "Users can manage own stream sessions"
  on stream_sessions for all using (auth.uid() = user_id);

-- Index for fast active-session lookups
create index if not exists stream_sessions_user_status
  on stream_sessions (user_id, status);

-- ─────────────────────────────────────────────────────────────
-- 4. STREAM ALERTS
--    Normalised alert events from all platforms.
--    Supabase Realtime is enabled on this table so the frontend
--    can subscribe and receive alerts in real time.
-- ─────────────────────────────────────────────────────────────
create table if not exists stream_alerts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  session_id  uuid references stream_sessions(id) on delete set null,
  platform    text not null,
  kind        text not null check (kind in ('follow','sub','giftsub','donation','raid')),
  user_name   text,
  amount      text,
  currency    text,
  viewers     integer,
  gift_count  integer,
  is_test     boolean default false,
  created_at  timestamptz default now()
);

alter table stream_alerts enable row level security;

create policy "Users can read own alerts"
  on stream_alerts for select using (auth.uid() = user_id);

-- Service role can insert (webhooks go through service role)
create policy "Service role can insert alerts"
  on stream_alerts for insert with check (true);

-- Index for fast per-user lookups ordered by time
create index if not exists stream_alerts_user_created
  on stream_alerts (user_id, created_at desc);

-- Enable Realtime on stream_alerts so the frontend can subscribe
-- (Run this in Supabase Dashboard → Database → Replication, or:)
alter publication supabase_realtime add table stream_alerts;

-- ─────────────────────────────────────────────────────────────
-- 5. AUTO-CREATE PROFILE ON SIGNUP
--    Trigger that runs after a new user signs up via Supabase Auth
-- ─────────────────────────────────────────────────────────────
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
