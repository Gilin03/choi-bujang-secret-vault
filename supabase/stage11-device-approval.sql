-- Stage 11 device approval. Stores public credential keys only; authenticator
-- private keys never leave the user's platform authenticator.
create table if not exists public.vault_registered_devices (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  credential_id text not null unique
    check (credential_id ~ '^[A-Za-z0-9_-]{20,}$'),
  credential_public_key jsonb not null
    check (credential_public_key ->> 'kty' = 'EC'
      and credential_public_key ->> 'crv' = 'P-256'
      and credential_public_key ->> 'alg' = 'ES256'),
  sign_count bigint not null default 0 check (sign_count >= 0),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'revoked')),
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  last_used_at timestamptz
);

create index if not exists vault_registered_devices_owner_status_idx
  on public.vault_registered_devices (owner_id, status);

create table if not exists public.vault_device_challenges (
  challenge_hash text primary key check (challenge_hash ~ '^[a-f0-9]{64}$'),
  owner_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('registration', 'status', 'request')),
  method text not null check (method in ('GET', 'POST', 'PUT', 'DELETE')),
  path text not null check (path like '/api/%' and position('?' in path) = 0),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists vault_device_challenges_expiry_idx
  on public.vault_device_challenges (owner_id, expires_at);

alter table public.vault_registered_devices enable row level security;
alter table public.vault_device_challenges enable row level security;

revoke all on table public.vault_registered_devices from public, anon, authenticated;
revoke all on table public.vault_device_challenges from public, anon, authenticated;
grant select, insert, update, delete on table public.vault_registered_devices to service_role;
grant select, insert, update, delete on table public.vault_device_challenges to service_role;

comment on table public.vault_registered_devices is
  'Stage 11 approved WebAuthn public credentials; private keys remain in platform authenticators.';
comment on table public.vault_device_challenges is
  'Stage 11 short-lived one-time challenge hashes consumed by the server.';
