-- Metadata only. Existing notes, owners, backups and policies are untouched.
create table public.vault_operation_events (
  request_id uuid primary key,
  owner_id uuid not null,
  checked_at timestamptz not null,
  method text not null check (method in ('GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS')),
  route text not null check (route in (
    '/api/my/notes', '/api/notes', '/api/notes/:id', '/api/notes/:id/restore',
    '/api/announcements', '/api/announcements/:id', '/api/session-approval/status',
    '/api/session-approval/request', '/api/session-approval/operations', '/unrecognized'
  )),
  status smallint not null check (status between 100 and 599),
  commit_sha text check (commit_sha ~ '^[a-f0-9]{40}$')
);
create index vault_operation_events_owner_time on public.vault_operation_events (owner_id, checked_at desc);
alter table public.vault_operation_events enable row level security;
revoke all privileges on table public.vault_operation_events from public, anon, authenticated, service_role;
grant select, insert on table public.vault_operation_events to service_role;
comment on table public.vault_operation_events is 'Stage 12 server HTTP metadata; no bodies, tokens, email or session identifiers.';
