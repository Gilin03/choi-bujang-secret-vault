-- Stage 10: immutable first-write snapshots and append-only recovery audit.
-- Apply after public.vault_notes exists. This intentionally does not backfill
-- current rows because current state is not evidence of a pre-incident copy.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.note_snapshots (
  snapshot_schema text not null check (snapshot_schema = 'aleph.note-snapshot.v1'),
  note_id uuid primary key,
  owner_id uuid not null,
  title text not null,
  content text not null,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  snapshot_version uuid not null,
  captured_at timestamptz not null,
  snapshot_sha256 text not null check (snapshot_sha256 ~ '^[0-9a-f]{64}$')
);

alter table public.note_snapshots enable row level security;
revoke all privileges on table public.note_snapshots from public, anon, authenticated, service_role;
grant select on table public.note_snapshots to service_role;

create table if not exists public.note_recovery_audit (
  audit_id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  actor_id uuid not null,
  note_id uuid not null,
  action text not null check (action in ('restore_note', 'restore_unchanged')),
  reason_code text not null,
  policy_revision text not null,
  policy_sha256 text not null check (policy_sha256 ~ '^[0-9a-f]{64}$'),
  snapshot_version uuid not null,
  snapshot_sha256 text not null check (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  before_state text not null check (before_state in ('modified', 'deleted', 'unchanged')),
  changed_fields jsonb not null check (jsonb_typeof(changed_fields) = 'array')
);

alter table public.note_recovery_audit enable row level security;
revoke all privileges on table public.note_recovery_audit from public, anon, authenticated, service_role;
grant insert on table public.note_recovery_audit to service_role;

create or replace function public.capture_first_note_snapshot()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_schema constant text := 'aleph.note-snapshot.v1';
  v_version uuid := gen_random_uuid();
  v_captured_at timestamptz := clock_timestamp();
  v_content_sha256 text;
  v_snapshot_sha256 text;
begin
  if new.owner_id is null then
    return new;
  end if;

  v_content_sha256 := encode(extensions.digest(
    convert_to(new.title || chr(31) || new.content, 'UTF8'), 'sha256'), 'hex');
  v_snapshot_sha256 := encode(extensions.digest(convert_to(
    v_schema || E'\n' || v_version::text || E'\n' || new.id::text || E'\n'
      || new.owner_id::text || E'\n' || v_content_sha256,
    'UTF8'), 'sha256'), 'hex');

  insert into public.note_snapshots (
    snapshot_schema, note_id, owner_id, title, content, content_sha256,
    snapshot_version, captured_at, snapshot_sha256
  ) values (
    v_schema, new.id, new.owner_id, new.title, new.content, v_content_sha256,
    v_version, v_captured_at, v_snapshot_sha256
  ) on conflict (note_id) do nothing;

  return new;
end;
$function$;

revoke execute on function public.capture_first_note_snapshot() from public, anon, authenticated, service_role;

do $trigger$
begin
  if not exists (
    select 1
    from pg_catalog.pg_trigger as existing_trigger
    where existing_trigger.tgrelid = 'public.vault_notes'::regclass
      and existing_trigger.tgname = 'vault_notes_capture_first_snapshot'
      and not existing_trigger.tgisinternal
  ) then
    execute 'create trigger vault_notes_capture_first_snapshot
      after insert on public.vault_notes
      for each row execute function public.capture_first_note_snapshot()';
  end if;
end;
$trigger$;
