-- Workflow v2: vendor-initiated completion + engineering acknowledgment,
-- day-vs-series closure for multi-day permits, and the High-Risk HCC gate.

alter table permits add column if not exists daily_log jsonb not null default '[]'::jsonb;
alter table permits add column if not exists hcc_approval jsonb not null default '{}'::jsonb;
alter table permits add column if not exists closure_mode text;
alter table permits add column if not exists completion_ack jsonb not null default '{}'::jsonb;
alter table permits add column if not exists submitted_by_staff text;
