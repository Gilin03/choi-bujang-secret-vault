-- Stage 8 adds separate private storage for class announcements and instructor grants.
-- Existing vault_notes rows, policies, and grants are not changed.
begin;

create table public.vault_announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  content text not null check (char_length(btrim(content)) between 1 and 5000),
  updated_by uuid not null,
  updated_at timestamptz not null default now()
);

create table public.vault_instructor_access (
  user_id uuid primary key references auth.users(id) on delete cascade,
  active boolean not null default true,
  granted_at timestamptz not null default now()
);

alter table public.vault_announcements enable row level security;
alter table public.vault_instructor_access enable row level security;

revoke all privileges on table public.vault_announcements from public, anon, authenticated;
revoke all privileges on table public.vault_instructor_access from public, anon, authenticated;
revoke all privileges on table public.vault_announcements from service_role;
revoke all privileges on table public.vault_instructor_access from service_role;
grant select, update on table public.vault_announcements to service_role;
grant select on table public.vault_instructor_access to service_role;

commit;
