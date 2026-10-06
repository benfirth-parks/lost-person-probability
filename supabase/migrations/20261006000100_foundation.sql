-- Foundation: extensions, schemas, roles, users, feature flags, audit.
--
-- Schemas
--   research    de-identified research and training data (exposed to the API, RLS on every table)
--   restricted  protected outcome data; never exposed, reachable only through definer functions
--   audit       append-only audit log

create extension if not exists postgis;
create extension if not exists pgcrypto;

create schema if not exists research;
create schema if not exists restricted;
create schema if not exists audit;

revoke all on schema restricted from public;
revoke all on schema audit from public;
grant usage on schema research to authenticated;
revoke all on schema research from anon;

-- ---------------------------------------------------------------------------
-- Roles and users
-- ---------------------------------------------------------------------------

create table research.application_roles (
  role text primary key,
  description text not null,
  enabled boolean not null,
  -- Operational roles are reserved and must stay disabled in this release.
  constraint operational_roles_disabled check (not (role like 'operational_%' or role = 'field_team_lead') or enabled = false)
);

insert into research.application_roles (role, description, enabled) values
  ('training_viewer', 'View assigned training cases and locked outputs', true),
  ('planner_trainee', 'Build and update training probability maps', true),
  ('evaluator', 'Configure retrospective cutoffs, lock runs, and reveal outcomes', true),
  ('analyst', 'Access approved de-identified case data and aggregate evaluation', true),
  ('instructor', 'Manage training timelines and exercise releases', true),
  ('administrator', 'Manage users, models, categories, basemaps, imports, and feature flags', true),
  ('operational_search_manager', 'Reserved for a future, separately approved operational release', false),
  ('operational_planning_staff', 'Reserved for a future, separately approved operational release', false),
  ('field_team_lead', 'Reserved for a future, separately approved operational release', false);

create table research.application_users (
  user_id uuid primary key,               -- auth.users.id
  display_code text not null unique,      -- e.g. "evaluator-03"; no names in the research interface
  role text not null references research.application_roles(role),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create or replace function research.current_app_role() returns text
language sql stable security definer set search_path = research, pg_temp as $$
  select u.role
  from research.application_users u
  join research.application_roles r on r.role = u.role
  where u.user_id = auth.uid() and u.active and r.enabled
$$;

create or replace function research.has_role(variadic roles text[]) returns boolean
language sql stable as $$
  select coalesce(research.current_app_role() = any(roles), false)
$$;

-- ---------------------------------------------------------------------------
-- Feature flags
-- ---------------------------------------------------------------------------

create table research.feature_flags (
  key text primary key,
  enabled boolean not null,
  description text not null,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  constraint operational_mode_locked_off check (key <> 'operational_mode' or enabled = false)
);

insert into research.feature_flags (key, enabled, description) values
  ('operational_mode', false, 'Live operational incidents. Locked off until a separate approval process completes.');

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------

create table audit.audit_events (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default clock_timestamp(),
  actor uuid,
  actor_role text,
  mode text,
  action text not null,                   -- insert | update | restricted_read | reveal | export | ...
  table_name text,
  record_id text,
  incident_id uuid,
  details jsonb not null default '{}'::jsonb
);

create or replace function audit.forbid_change() returns trigger
language plpgsql as $$
begin
  raise exception '% on %.% is not allowed: records are immutable', tg_op, tg_table_schema, tg_table_name
    using errcode = 'insufficient_privilege';
end $$;

create trigger audit_events_append_only before update or delete on audit.audit_events
  for each row execute function audit.forbid_change();

create or replace function audit.log(p_action text, p_table text, p_record text, p_incident uuid, p_details jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = audit, research, pg_temp as $$
begin
  insert into audit.audit_events (actor, actor_role, action, table_name, record_id, incident_id, details, mode)
  values (auth.uid(), research.current_app_role(), p_action, p_table, p_record, p_incident, p_details,
          (select i.mode from research.search_incidents i where i.id = p_incident));
end $$;

-- Generic row-change audit trigger. Expects an incident_id column or passes null.
create or replace function audit.log_row() returns trigger
language plpgsql security definer set search_path = audit, research, pg_temp as $$
declare
  v_incident uuid;
  v_row jsonb := to_jsonb(new);
begin
  v_incident := nullif(v_row ->> 'incident_id', '')::uuid;
  perform audit.log(lower(tg_op), tg_table_schema || '.' || tg_table_name, v_row ->> 'id', v_incident, '{}'::jsonb);
  return new;
end $$;
