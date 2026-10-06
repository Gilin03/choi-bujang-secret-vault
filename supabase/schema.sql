create table public.vault_notes (
  id uuid primary key default gen_random_uuid(),
  sort_order integer not null unique,
  owner_id uuid,
  title text not null,
  content text not null
);

create sequence public.vault_notes_sort_order_seq;

select setval(
  'public.vault_notes_sort_order_seq',
  coalesce(max(sort_order), 1),
  coalesce(max(sort_order) is not null, false)
)
from public.vault_notes;

alter table public.vault_notes
  alter column sort_order set default nextval('public.vault_notes_sort_order_seq');

alter sequence public.vault_notes_sort_order_seq
  owned by public.vault_notes.sort_order;

alter table public.vault_notes enable row level security;

revoke all privileges on table public.vault_notes from public, anon, authenticated;
grant select on table public.vault_notes to service_role;
revoke all privileges on sequence public.vault_notes_sort_order_seq from public, anon, authenticated;
grant usage, select on sequence public.vault_notes_sort_order_seq to service_role;
