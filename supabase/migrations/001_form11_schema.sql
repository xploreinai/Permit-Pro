-- Permit Pro — TADE-OSHMS-Form 11 schema. Pilot mode (open access, no auth),
-- same deliberate tradeoff made for E-valuate: fastest path to a working
-- demo. Revisit before anyone outside the pilot team uses this.

create table if not exists permits (
  id uuid primary key default gen_random_uuid(),
  -- True DB-assigned serial: Postgres guarantees this is unique and strictly
  -- increasing on insert, even under concurrent submissions. Never reused —
  -- if a permit is later deleted, its number stays visibly missing, which is
  -- the point: gaps in the sequence are how you spot a removed/voided permit.
  permit_seq bigint generated always as identity,
  permit_ref text, -- human-facing "PP-000047" label derived from permit_seq

  form_ref text not null default 'TADE-OSHMS-Form 11',
  release_date text not null default 'February 2024',
  revision_no text not null default '01',

  -- Section 1-3: validity window & daily hours
  start_date date not null,
  end_date date not null,
  duration_days integer not null default 1,
  start_time text not null,
  end_time text not null,
  daily_schedule jsonb not null default '[]'::jsonb,

  -- Section 1-3: particulars
  company_name text not null,
  mobile_no text not null,
  work_location text not null,
  description_of_work text not null,
  risk_level text not null default 'Regular',
  vehicle_plate text,

  -- Section 4-7
  permit_to_work jsonb not null default '{}'::jsonb,
  documents jsonb not null default '{}'::jsonb,
  safety_precautions jsonb not null default '{}'::jsonb,
  ppe jsonb not null default '{}'::jsonb,
  contractor_confirmation jsonb not null default '{}'::jsonb,

  -- Section 8-10
  department_receipt jsonb not null default '{}'::jsonb,
  cessation_of_work jsonb not null default '{}'::jsonb,
  cancellation jsonb not null default '{}'::jsonb,

  -- Crew roster (Authorized Personnel Register)
  workers jsonb not null default '[]'::jsonb,

  status text not null default 'pending_receipt',
  id_photo_url text,

  created_at timestamptz not null default now(),
  updated_at timestamptz,
  last_updated timestamptz not null default now()
);

create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  permit_id uuid references permits(id) on delete cascade,
  event_type text not null,
  message text not null,
  actor text,
  created_at timestamptz not null default now()
);

-- Populate permit_ref from the DB-assigned permit_seq at insert time. Identity
-- column defaults are applied before BEFORE INSERT triggers run, so
-- new.permit_seq is already set here — one round trip, no race condition.
create or replace function set_permit_ref() returns trigger as $$
begin
  new.permit_ref := 'PP-' || lpad(new.permit_seq::text, 6, '0');
  return new;
end;
$$ language plpgsql;

create trigger permits_set_ref before insert on permits
for each row execute function set_permit_ref();

alter table permits enable row level security;
alter table audit_logs enable row level security;

-- Open access for pilot mode — anyone with the anon key can read/write.
-- Same tradeoff Ram chose for E-valuate: speed over correctness on auth.
create policy "permits_open_select" on permits for select using (true);
create policy "permits_open_insert" on permits for insert with check (true);
create policy "permits_open_update" on permits for update using (true);

create policy "audit_logs_open_select" on audit_logs for select using (true);
create policy "audit_logs_open_insert" on audit_logs for insert with check (true);

-- Enable realtime so subscribePermits/subscribeAuditLogs get live updates.
alter publication supabase_realtime add table permits;
alter publication supabase_realtime add table audit_logs;
