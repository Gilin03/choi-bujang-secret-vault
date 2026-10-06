create table public.vault_notes (
  id uuid primary key default gen_random_uuid(),
  sort_order integer not null unique,
  owner_id uuid,
  title text not null,
  content text not null
);

alter table public.vault_notes enable row level security;

revoke all privileges on table public.vault_notes from public, anon, authenticated;
grant select on table public.vault_notes to service_role;
