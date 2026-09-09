-- Disposable-database bootstrap for the F-03 migration replay harness.
--
-- Reproduces the parts of a stock Supabase project that exist BEFORE the
-- first repository migration runs: the platform roles, the auth/storage
-- schemas, and the handful of auth helpers this tree's migrations call.
-- Nothing here is a repository migration and nothing here is applied to any
-- hosted project -- it exists only so `supabase/migrations/*.sql` can be
-- replayed end to end against a throwaway local PostgreSQL cluster.

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator noinherit login;
create role supabase_auth_admin nologin noinherit createrole;
create role supabase_storage_admin nologin noinherit createrole;
create role dashboard_user nologin noinherit;
create role postgres nologin noinherit createrole createdb bypassrls;

grant anon, authenticated, service_role to authenticator;
grant anon, authenticated, service_role, supabase_auth_admin, supabase_storage_admin, dashboard_user, postgres to supabase_admin;

create schema if not exists extensions;
create schema if not exists auth authorization supabase_auth_admin;
create schema if not exists storage authorization supabase_storage_admin;
create schema if not exists graphql_public;
create schema if not exists supabase_migrations;

grant usage on schema extensions to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role, supabase_auth_admin;
grant usage on schema storage to anon, authenticated, service_role, supabase_storage_admin;
grant usage on schema public to anon, authenticated, service_role;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;

alter database postgres set search_path to public, extensions;

-- ── auth ────────────────────────────────────────────────────────────────────

create table auth.users (
  id                          uuid primary key default gen_random_uuid(),
  instance_id                 uuid,
  aud                         varchar(255),
  role                        varchar(255),
  email                       varchar(255),
  encrypted_password          varchar(255),
  email_confirmed_at          timestamptz,
  invited_at                  timestamptz,
  confirmation_token          varchar(255),
  confirmation_sent_at        timestamptz,
  recovery_token              varchar(255),
  recovery_sent_at            timestamptz,
  email_change_token_new      varchar(255),
  email_change                varchar(255),
  email_change_sent_at        timestamptz,
  last_sign_in_at             timestamptz,
  raw_app_meta_data           jsonb,
  raw_user_meta_data          jsonb,
  is_super_admin              boolean,
  created_at                  timestamptz default now(),
  updated_at                  timestamptz default now(),
  phone                       text unique default null,
  phone_confirmed_at          timestamptz,
  phone_change                text default '',
  phone_change_token          varchar(255) default '',
  phone_change_sent_at        timestamptz,
  confirmed_at                timestamptz,
  email_change_token_current  varchar(255) default '',
  email_change_confirm_status smallint default 0,
  banned_until                timestamptz,
  reauthentication_token      varchar(255) default '',
  reauthentication_sent_at    timestamptz,
  is_sso_user                 boolean not null default false,
  deleted_at                  timestamptz,
  is_anonymous                boolean not null default false
);

create table auth.sessions (
  id            uuid primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  created_at    timestamptz,
  updated_at    timestamptz,
  factor_id     uuid,
  aal           text,
  not_after     timestamptz,
  refreshed_at  timestamp,
  user_agent    text,
  ip            inet,
  tag           text
);

create table auth.refresh_tokens (
  id          bigserial primary key,
  instance_id uuid,
  token       varchar(255),
  user_id     varchar(255),
  revoked     boolean,
  created_at  timestamptz,
  updated_at  timestamptz,
  parent      varchar(255),
  session_id  uuid references auth.sessions(id) on delete cascade
);

create table auth.identities (
  provider_id     text not null,
  user_id         uuid not null references auth.users(id) on delete cascade,
  identity_data   jsonb not null,
  provider        text not null,
  last_sign_in_at timestamptz,
  created_at      timestamptz,
  updated_at      timestamptz,
  email           text,
  id              uuid primary key default gen_random_uuid()
);

-- Request-context helpers. In a hosted project these read the GoTrue JWT out
-- of the PostgREST request GUCs; the harness keeps that exact contract so
-- RLS policies compile and evaluate identically.
create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

create or replace function auth.email()
returns text
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  )::text
$$;

grant usage on schema auth to postgres;
grant all on all tables in schema auth to supabase_auth_admin, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role, supabase_auth_admin;

-- ── storage ─────────────────────────────────────────────────────────────────

create table storage.buckets (
  id                 text primary key,
  name               text not null,
  owner              uuid,
  created_at         timestamptz default now(),
  updated_at         timestamptz default now(),
  public             boolean default false,
  avif_autodetection boolean default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  owner_id           text
);

create table storage.objects (
  id               uuid primary key default gen_random_uuid(),
  bucket_id        text references storage.buckets(id),
  name             text,
  owner            uuid,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now(),
  last_accessed_at timestamptz default now(),
  metadata         jsonb,
  path_tokens      text[] generated always as (string_to_array(name, '/')) stored,
  version          text,
  owner_id         text,
  user_metadata    jsonb
);

create unique index if not exists bucketid_objname on storage.objects (bucket_id, name);

alter table storage.objects enable row level security;
alter table storage.buckets enable row level security;

create or replace function storage.foldername(name text)
returns text[]
language plpgsql
immutable
as $$
declare
  _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1 : array_length(_parts, 1) - 1];
end
$$;

create or replace function storage.filename(name text)
returns text
language plpgsql
immutable
as $$
declare
  _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[array_length(_parts, 1)];
end
$$;

create or replace function storage.extension(name text)
returns text
language plpgsql
immutable
as $$
declare
  _parts text[];
  _filename text;
begin
  select string_to_array(name, '/') into _parts;
  select _parts[array_length(_parts, 1)] into _filename;
  return reverse(split_part(reverse(_filename), '.', 1));
end
$$;

grant all on all tables in schema storage to supabase_storage_admin, service_role;
grant execute on all functions in schema storage to anon, authenticated, service_role, supabase_storage_admin;

-- ── migration ledger ────────────────────────────────────────────────────────
--
-- Same shape the Supabase CLI creates. The harness writes one row per applied
-- file so an upgrade fixture can be cut at an exact historical version.

create table if not exists supabase_migrations.schema_migrations (
  version    text primary key,
  statements text[],
  name       text
);
