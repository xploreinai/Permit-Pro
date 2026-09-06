-- Adds the Day/Night permit time-type column to an already-deployed database.
-- (001_form11_schema.sql now includes this column too, for fresh setups.)
alter table permits add column if not exists permit_time_type text not null default 'day';
