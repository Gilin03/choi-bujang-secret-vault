-- Stage 10: retain the first owned-note state for one-note recovery.
-- Apply once in Supabase SQL Editor. Re-running does not replace saved backups.

begin;

create table if not exists public.vault_note_backups (
  note_id uuid primary key,
  owner_id uuid not null,
  title text not null,
  content text not null,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  captured_at timestamptz not null default pg_catalog.now()
);

alter table public.vault_note_backups enable row level security;
revoke all privileges on table public.vault_note_backups from public, anon, authenticated, service_role;
grant select on table public.vault_note_backups to service_role;

create or replace function public.capture_vault_note_backup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.owner_id is not null then
    insert into public.vault_note_backups (
      note_id, owner_id, title, content, content_sha256
    ) values (
      new.id,
      new.owner_id,
      new.title,
      new.content,
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(new.content, 'UTF8')), 'hex')
    )
    on conflict (note_id) do nothing;
  end if;
  return new;
end;
$$;

revoke all privileges on function public.capture_vault_note_backup() from public, anon, authenticated, service_role;

drop trigger if exists vault_notes_capture_first_backup on public.vault_notes;
create trigger vault_notes_capture_first_backup
after insert on public.vault_notes
for each row execute function public.capture_vault_note_backup();

-- Capture the existing owned notes at setup time. The primary key and
-- DO NOTHING preserve each first backup on every later run.
insert into public.vault_note_backups (
  note_id, owner_id, title, content, content_sha256
)
select
  id,
  owner_id,
  title,
  content,
  pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(content, 'UTF8')), 'hex')
from public.vault_notes
where owner_id is not null
on conflict (note_id) do nothing;

commit;

-- Read-only permission checks. Expected: vault_notes CRUD and backup SELECT
-- are true for service_role; trigger-function EXECUTE is false for API roles.
select
  has_table_privilege('service_role', 'public.vault_notes', 'select') as service_role_vault_notes_select,
  has_table_privilege('service_role', 'public.vault_notes', 'insert') as service_role_vault_notes_insert,
  has_table_privilege('service_role', 'public.vault_notes', 'update') as service_role_vault_notes_update,
  has_table_privilege('service_role', 'public.vault_notes', 'delete') as service_role_vault_notes_delete;

select
  has_table_privilege('service_role', 'public.vault_note_backups', 'select') as service_role_vault_note_backups_select;

select
  has_function_privilege('anon', 'public.capture_vault_note_backup()', 'execute') as anon_can_execute_capture,
  has_function_privilege('authenticated', 'public.capture_vault_note_backup()', 'execute') as authenticated_can_execute_capture,
  has_function_privilege('service_role', 'public.capture_vault_note_backup()', 'execute') as service_role_can_execute_capture;
