-- Stage 11 session approval. Each row is scoped to one server-verified
-- Supabase Auth session_id; it is not a physical device identity.
create table if not exists public.vault_session_approvals (
  session_id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'approved')),
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  check ((status = 'pending' and approved_at is null)
      or (status = 'approved' and approved_at is not null))
);

create index if not exists vault_session_approvals_owner_status_idx
  on public.vault_session_approvals (owner_id, status);

alter table public.vault_session_approvals enable row level security;
revoke all on table public.vault_session_approvals from public, anon, authenticated;
grant select, insert, update, delete on table public.vault_session_approvals to service_role;

comment on table public.vault_session_approvals is
  'Stage 11 learning approval bound to one verified Supabase Auth session_id, not a physical device.';
