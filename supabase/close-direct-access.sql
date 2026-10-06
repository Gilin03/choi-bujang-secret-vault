-- Stage 5: inspect direct table privileges before applying the revocation.
-- Run the Before queries, then the Apply block, then the After queries.

-- Before: direct grants on the notes table.
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'vault_notes'
  and grantee in ('PUBLIC', 'anon', 'authenticated')
order by grantee, privilege_type;

-- Before: effective privileges, including inherited PUBLIC grants.
select
  has_table_privilege('anon', 'public.vault_notes', 'select') as anon_select,
  has_table_privilege('anon', 'public.vault_notes', 'insert') as anon_insert,
  has_table_privilege('anon', 'public.vault_notes', 'update') as anon_update,
  has_table_privilege('anon', 'public.vault_notes', 'delete') as anon_delete,
  has_table_privilege('authenticated', 'public.vault_notes', 'select') as authenticated_select,
  has_table_privilege('authenticated', 'public.vault_notes', 'insert') as authenticated_insert,
  has_table_privilege('authenticated', 'public.vault_notes', 'update') as authenticated_update,
  has_table_privilege('authenticated', 'public.vault_notes', 'delete') as authenticated_delete;

-- Before: direct sequence access used by the sort_order default.
select
  has_sequence_privilege('anon', 'public.vault_notes_sort_order_seq', 'usage') as anon_sequence_usage,
  has_sequence_privilege('authenticated', 'public.vault_notes_sort_order_seq', 'usage') as authenticated_sequence_usage;

-- Apply: revoke only direct access to the notes table and its insert sequence.
-- This leaves the service role used by the Vercel function unchanged.
begin;

revoke all privileges on table public.vault_notes from public, anon, authenticated;
revoke all privileges on sequence public.vault_notes_sort_order_seq from public, anon, authenticated;

commit;

-- After: role_table_grants should return no rows for these three grantees.
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'vault_notes'
  and grantee in ('PUBLIC', 'anon', 'authenticated')
order by grantee, privilege_type;

-- After: every result below should be false.
select
  has_table_privilege('anon', 'public.vault_notes', 'select') as anon_select,
  has_table_privilege('anon', 'public.vault_notes', 'insert') as anon_insert,
  has_table_privilege('anon', 'public.vault_notes', 'update') as anon_update,
  has_table_privilege('anon', 'public.vault_notes', 'delete') as anon_delete,
  has_table_privilege('authenticated', 'public.vault_notes', 'select') as authenticated_select,
  has_table_privilege('authenticated', 'public.vault_notes', 'insert') as authenticated_insert,
  has_table_privilege('authenticated', 'public.vault_notes', 'update') as authenticated_update,
  has_table_privilege('authenticated', 'public.vault_notes', 'delete') as authenticated_delete;

-- After: both sequence results should be false.
select
  has_sequence_privilege('anon', 'public.vault_notes_sort_order_seq', 'usage') as anon_sequence_usage,
  has_sequence_privilege('authenticated', 'public.vault_notes_sort_order_seq', 'usage') as authenticated_sequence_usage;
