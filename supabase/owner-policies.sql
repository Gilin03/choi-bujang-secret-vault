-- Run the "Before" query by itself and keep its result.
-- Then run the policy/grant statements, followed by the "After" query.

-- Before: current table grants and effective CRUD privileges.
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'vault_notes'
  and grantee in ('PUBLIC', 'anon', 'authenticated')
order by grantee, privilege_type;

select
  has_table_privilege('anon', 'public.vault_notes', 'select') as anon_select,
  has_table_privilege('anon', 'public.vault_notes', 'insert') as anon_insert,
  has_table_privilege('anon', 'public.vault_notes', 'update') as anon_update,
  has_table_privilege('anon', 'public.vault_notes', 'delete') as anon_delete,
  has_table_privilege('authenticated', 'public.vault_notes', 'select') as authenticated_select,
  has_table_privilege('authenticated', 'public.vault_notes', 'insert') as authenticated_insert,
  has_table_privilege('authenticated', 'public.vault_notes', 'update') as authenticated_update,
  has_table_privilege('authenticated', 'public.vault_notes', 'delete') as authenticated_delete;

select
  has_sequence_privilege('anon', 'public.vault_notes_sort_order_seq', 'usage') as anon_sequence_usage,
  has_sequence_privilege('authenticated', 'public.vault_notes_sort_order_seq', 'usage') as authenticated_sequence_usage;

-- Apply: only authenticated users receive table CRUD privileges.
begin;

revoke all on table public.vault_notes from public, anon, authenticated;
grant select, insert, update, delete on table public.vault_notes to authenticated;
grant usage on sequence public.vault_notes_sort_order_seq to authenticated;

alter table public.vault_notes enable row level security;

drop policy if exists vault_notes_select_owner on public.vault_notes;
drop policy if exists vault_notes_insert_owner on public.vault_notes;
drop policy if exists vault_notes_update_owner on public.vault_notes;
drop policy if exists vault_notes_delete_owner on public.vault_notes;

create policy vault_notes_select_owner
on public.vault_notes
for select
to authenticated
using ((select auth.uid()) = owner_id);

create policy vault_notes_insert_owner
on public.vault_notes
for insert
to authenticated
with check ((select auth.uid()) = owner_id);

create policy vault_notes_update_owner
on public.vault_notes
for update
to authenticated
using ((select auth.uid()) = owner_id)
with check ((select auth.uid()) = owner_id);

create policy vault_notes_delete_owner
on public.vault_notes
for delete
to authenticated
using ((select auth.uid()) = owner_id);

commit;

-- After: authenticated should have exactly CRUD; anon should have none.
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'vault_notes'
  and grantee in ('PUBLIC', 'anon', 'authenticated')
order by grantee, privilege_type;

select
  has_table_privilege('anon', 'public.vault_notes', 'select') as anon_select,
  has_table_privilege('anon', 'public.vault_notes', 'insert') as anon_insert,
  has_table_privilege('anon', 'public.vault_notes', 'update') as anon_update,
  has_table_privilege('anon', 'public.vault_notes', 'delete') as anon_delete,
  has_table_privilege('authenticated', 'public.vault_notes', 'select') as authenticated_select,
  has_table_privilege('authenticated', 'public.vault_notes', 'insert') as authenticated_insert,
  has_table_privilege('authenticated', 'public.vault_notes', 'update') as authenticated_update,
  has_table_privilege('authenticated', 'public.vault_notes', 'delete') as authenticated_delete;

select
  has_sequence_privilege('anon', 'public.vault_notes_sort_order_seq', 'usage') as anon_sequence_usage,
  has_sequence_privilege('authenticated', 'public.vault_notes_sort_order_seq', 'usage') as authenticated_sequence_usage;
