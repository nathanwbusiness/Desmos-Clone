-- Keys the browser bridge uses to reach the desmos-bridge Edge Function.
-- Only SHA-256 hashes are stored. Add a key:
--   insert into desmos.bridge_keys (label, key_hash)
--   values ('Nathan laptop', encode(sha256(convert_to('<the key>', 'UTF8')), 'hex'));
-- Revoke one: update desmos.bridge_keys set revoked_at = now() where label = '...';
create table if not exists desmos.bridge_keys (
  id         uuid primary key default gen_random_uuid(),
  label      text not null,
  key_hash   text not null unique,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

alter table desmos.bridge_keys enable row level security;
