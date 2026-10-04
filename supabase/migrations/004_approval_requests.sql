-- Email approvals: one row per (permit, approver) request.
--
-- SECURITY: this table holds the hashed approval tokens, so it must NOT be
-- readable or writable with the public anon key (which ships in the browser
-- bundle). RLS is enabled with deliberately NO policies, and anon/authenticated
-- privileges are revoked. Only the server functions in /api, which use the
-- service-role key, can touch it.

create table if not exists approval_requests (
  id uuid primary key default gen_random_uuid(),
  permit_id uuid not null references permits(id) on delete cascade,
  kind text not null check (kind in ('engineering', 'hcc')),
  recipient_email text not null,
  token_hash text not null unique,   -- sha256 of the link token; the raw token only ever exists in the email
  reply_code text not null unique,   -- random code embedded in the reply-to address
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'superseded', 'failed', 'expired')),
  decided_via text check (decided_via in ('link', 'email_reply')),
  decided_at timestamptz,
  decision_note text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists approval_requests_permit_idx
  on approval_requests (permit_id, kind, status);

alter table approval_requests enable row level security;
revoke all on approval_requests from anon, authenticated;
