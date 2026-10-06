-- Row-level security, privileges, audit triggers and the server-side
-- functions for locking runs and revealing outcomes.
--
-- Tables are owned by the migration role, which bypasses RLS; definer functions
-- rely on that and do their own role checks.
--
-- Deny by default: RLS is enabled on every research table, anon gets nothing,
-- authenticated gets SELECT/INSERT only where a policy allows it. Nothing in
-- research can be updated or deleted directly; state changes go through the
-- definer functions below, which check the caller's role and write audit events.

-- ---------------------------------------------------------------------------
-- Access helpers
-- ---------------------------------------------------------------------------

create or replace function research.is_member(p_incident uuid) returns boolean
language sql stable security definer set search_path = research, pg_temp as $$
  select exists (select 1 from research.incident_members m where m.incident_id = p_incident and m.user_id = auth.uid())
$$;

create or replace function research.incident_mode(p_incident uuid) returns text
language sql stable security definer set search_path = research, pg_temp as $$
  select mode from research.search_incidents where id = p_incident
$$;

create or replace function research.incident_cutoff(p_incident uuid) returns timestamptz
language sql stable security definer set search_path = research, pg_temp as $$
  select information_cutoff from research.search_incidents where id = p_incident
$$;

create or replace function research.can_read_incident(p_incident uuid) returns boolean
language sql stable as $$
  select research.current_app_role() is not null and (
    research.has_role('administrator', 'analyst', 'evaluator')
    or (research.has_role('instructor') and research.incident_mode(p_incident) = 'training')
    or research.is_member(p_incident))
$$;

create or replace function research.can_write_incident(p_incident uuid) returns boolean
language sql stable as $$
  select research.has_role('administrator')
    or (research.has_role('planner_trainee', 'evaluator', 'instructor') and research.is_member(p_incident))
$$;

-- Evaluators and administrators may see information after the cutoff (to build
-- and audit cases). Everyone else sees only what planners had at the cutoff.
create or replace function research.can_see_input(p_incident uuid, p_available_at timestamptz) returns boolean
language sql stable as $$
  select research.can_read_incident(p_incident)
    and (research.has_role('administrator', 'evaluator') or p_available_at <= research.incident_cutoff(p_incident))
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke all on all tables in schema research from anon, authenticated;
revoke all on all tables in schema restricted from anon, authenticated;
revoke all on all tables in schema audit from anon, authenticated;
revoke usage on schema restricted from anon, authenticated;
revoke usage on schema audit from anon, authenticated;

grant select on all tables in schema research to authenticated;
grant insert on
  research.scenarios, research.clues, research.clue_likelihood_models, research.assignments,
  research.search_tracks, research.assignment_pod_surfaces, research.probability_surfaces,
  research.probability_unit_values, research.probability_updates, research.manual_adjustments,
  research.search_domains, research.terrain_units, research.evaluation_runs
  to authenticated;
grant insert, update on
  research.search_incidents, research.incident_members, research.subjects, research.planning_points,
  research.intended_routes, research.operating_areas, research.model_versions, research.prior_models,
  research.pod_models, research.application_users
  to authenticated;  -- still gated to administrators by RLS

-- Raw clue statements stay server-side: clients get every clue column except the ciphertext.
revoke select on research.clues from authenticated;
do $$
declare cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
  from information_schema.columns
  where table_schema = 'research' and table_name = 'clues' and column_name <> 'restricted_payload_ciphertext';
  execute format('grant select (%s) on research.clues to authenticated', cols);
end $$;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'research' loop
    execute format('alter table research.%I enable row level security', t);
  end loop;
end $$;
alter table restricted.found_locations enable row level security;  -- no policies: nobody but definer functions

-- Reference data readable by any active user, writable by administrators.
do $$
declare t text;
begin
  foreach t in array array['application_roles', 'operating_areas', 'model_versions', 'prior_models', 'pod_models', 'feature_flags'] loop
    execute format('create policy %I on research.%I for select to authenticated using (research.current_app_role() is not null)', t || '_read', t);
    execute format($p$create policy %I on research.%I for insert to authenticated with check (research.has_role('administrator'))$p$, t || '_admin_insert', t);
    execute format($p$create policy %I on research.%I for update to authenticated using (research.has_role('administrator')) with check (research.has_role('administrator'))$p$, t || '_admin_update', t);
  end loop;
end $$;

create policy application_users_read on research.application_users for select to authenticated
  using (user_id = auth.uid() or research.has_role('administrator'));
create policy application_users_admin_insert on research.application_users for insert to authenticated
  with check (research.has_role('administrator'));
create policy application_users_admin_update on research.application_users for update to authenticated
  using (research.has_role('administrator')) with check (research.has_role('administrator'));

create policy incidents_read on research.search_incidents for select to authenticated
  using (research.can_read_incident(id));
create policy incidents_admin_insert on research.search_incidents for insert to authenticated
  with check (research.has_role('administrator'));
create policy incidents_admin_update on research.search_incidents for update to authenticated
  using (research.has_role('administrator')) with check (research.has_role('administrator'));

create policy members_read on research.incident_members for select to authenticated
  using (user_id = auth.uid() or research.has_role('administrator', 'evaluator', 'instructor'));
create policy members_assign on research.incident_members for insert to authenticated
  with check (research.has_role('administrator', 'evaluator', 'instructor') and research.can_read_incident(incident_id));

-- Case data written by import (administrators); read by anyone who can read the case.
do $$
declare t text;
begin
  foreach t in array array['subjects'] loop
    execute format('create policy %I on research.%I for select to authenticated using (research.can_read_incident(incident_id))', t || '_read', t);
    execute format($p$create policy %I on research.%I for insert to authenticated with check (research.has_role('administrator'))$p$, t || '_admin_insert', t);
  end loop;
  -- Time-stamped inputs: hidden after the cutoff unless the caller may see the full timeline.
  foreach t in array array['planning_points', 'intended_routes'] loop
    execute format('create policy %I on research.%I for select to authenticated using (research.can_see_input(incident_id, available_at))', t || '_read', t);
    execute format($p$create policy %I on research.%I for insert to authenticated with check (research.has_role('administrator'))$p$, t || '_admin_insert', t);
  end loop;
  foreach t in array array['clues', 'assignments'] loop
    execute format('create policy %I on research.%I for select to authenticated using (research.can_see_input(incident_id, available_at))', t || '_read', t);
    execute format('create policy %I on research.%I for insert to authenticated with check (research.can_write_incident(incident_id) and created_by = auth.uid())', t || '_insert', t);
  end loop;
  foreach t in array array['scenarios', 'search_domains'] loop
    execute format('create policy %I on research.%I for select to authenticated using (research.can_read_incident(incident_id))', t || '_read', t);
    execute format('create policy %I on research.%I for insert to authenticated with check (research.can_write_incident(incident_id) and created_by = auth.uid())', t || '_insert', t);
  end loop;
end $$;

create policy tracks_read on research.search_tracks for select to authenticated
  using (exists (select 1 from research.assignments a where a.id = assignment_id)
         and research.can_see_input((select a.incident_id from research.assignments a where a.id = assignment_id), available_at));
create policy tracks_insert on research.search_tracks for insert to authenticated
  with check (research.can_write_incident((select a.incident_id from research.assignments a where a.id = assignment_id)));

create policy pod_surfaces_read on research.assignment_pod_surfaces for select to authenticated
  using (exists (select 1 from research.assignments a where a.id = assignment_id));
create policy pod_surfaces_insert on research.assignment_pod_surfaces for insert to authenticated
  with check (created_by = auth.uid()
              and research.can_write_incident((select a.incident_id from research.assignments a where a.id = assignment_id)));

create policy clue_lr_read on research.clue_likelihood_models for select to authenticated
  using (exists (select 1 from research.clues c where c.id = clue_id));
create policy clue_lr_insert on research.clue_likelihood_models for insert to authenticated
  with check (reviewer_id = auth.uid()
              and research.can_write_incident((select c.incident_id from research.clues c where c.id = clue_id)));

create policy terrain_read on research.terrain_units for select to authenticated
  using (exists (select 1 from research.search_domains d where d.id = search_domain_id));
create policy terrain_insert on research.terrain_units for insert to authenticated
  with check (research.can_write_incident((select d.incident_id from research.search_domains d where d.id = search_domain_id)));

create policy surfaces_read on research.probability_surfaces for select to authenticated
  using (research.can_read_incident(incident_id));
create policy surfaces_insert on research.probability_surfaces for insert to authenticated
  with check (research.can_write_incident(incident_id) and created_by = auth.uid() and locked_at is null);

create policy unit_values_read on research.probability_unit_values for select to authenticated
  using (exists (select 1 from research.probability_surfaces s where s.id = surface_id));
create policy unit_values_insert on research.probability_unit_values for insert to authenticated
  with check (exists (select 1 from research.probability_surfaces s
                      where s.id = surface_id and s.created_by = auth.uid() and s.locked_at is null));

create policy updates_read on research.probability_updates for select to authenticated
  using (research.can_read_incident(incident_id));
create policy updates_insert on research.probability_updates for insert to authenticated
  with check (research.can_write_incident(incident_id) and committed_by = auth.uid());

create policy adjustments_read on research.manual_adjustments for select to authenticated
  using (research.can_read_incident(incident_id));
create policy adjustments_insert on research.manual_adjustments for insert to authenticated
  with check (research.can_write_incident(incident_id) and approved_by = auth.uid());

create policy evaluation_read on research.evaluation_runs for select to authenticated
  using (research.can_read_incident(incident_id));
create policy evaluation_insert on research.evaluation_runs for insert to authenticated
  with check (research.has_role('evaluator', 'administrator', 'instructor') and research.can_read_incident(incident_id)
              and created_by = auth.uid() and status = 'open');

-- ---------------------------------------------------------------------------
-- Audit triggers
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['search_incidents', 'incident_members', 'scenarios', 'clues', 'assignments', 'search_tracks',
                           'probability_surfaces', 'probability_updates', 'manual_adjustments', 'evaluation_runs',
                           'application_users', 'prior_models', 'pod_models', 'feature_flags'] loop
    execute format('create trigger %I after insert or update on research.%I for each row execute function audit.log_row()', t || '_audit', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Evaluation workflow functions
-- ---------------------------------------------------------------------------

create or replace function research.lock_evaluation_run(
  p_run uuid, p_surface uuid, p_baselines uuid[], p_model_versions jsonb, p_input_hashes jsonb
) returns research.evaluation_runs
language plpgsql security definer set search_path = research, audit, pg_temp as $$
declare
  r research.evaluation_runs;
  s research.probability_surfaces;
begin
  select * into r from research.evaluation_runs where id = p_run for update;
  if not found or not research.can_read_incident(r.incident_id) then
    raise exception 'evaluation run not found' using errcode = 'no_data_found';
  end if;
  if not research.has_role('evaluator', 'administrator', 'instructor') then
    raise exception 'your role may not lock evaluation runs' using errcode = 'insufficient_privilege';
  end if;
  if r.status <> 'open' then raise exception 'run is already %', r.status; end if;
  select * into s from research.probability_surfaces where id = p_surface;
  if not found or s.incident_id <> r.incident_id then
    raise exception 'surface does not belong to this incident';
  end if;
  if exists (select 1 from unnest(p_baselines) b
             where not exists (select 1 from research.probability_surfaces x where x.id = b and x.incident_id = r.incident_id)) then
    raise exception 'every baseline must be a surface of this incident';
  end if;
  update research.probability_surfaces set locked_at = now() where id = any(array_append(p_baselines, p_surface)) and locked_at is null;
  update research.evaluation_runs
     set status = 'locked', locked_surface_id = p_surface, baseline_surface_ids = p_baselines,
         model_versions = p_model_versions, input_hashes = p_input_hashes, locked_by = auth.uid(), locked_at = now()
   where id = p_run
  returning * into r;
  perform audit.log('lock', 'research.evaluation_runs', p_run::text, r.incident_id,
                    jsonb_build_object('surface', p_surface, 'baselines', p_baselines));
  return r;
end $$;

-- Returns the outcome ciphertext only after the run is locked, only to an
-- authorised role, and records the read. Decryption happens in the server
-- function that holds the key.
create or replace function research.reveal_outcome(p_run uuid)
returns table (encrypted_geometry text, found_at timestamptz)
language plpgsql security definer set search_path = research, restricted, audit, pg_temp as $$
declare r research.evaluation_runs;
begin
  select * into r from research.evaluation_runs where id = p_run for update;
  if not found or not research.can_read_incident(r.incident_id) then
    raise exception 'evaluation run not found' using errcode = 'no_data_found';
  end if;
  if not (research.has_role('evaluator', 'administrator')
          or (research.has_role('instructor') and research.incident_mode(r.incident_id) = 'training')) then
    raise exception 'your role may not reveal outcomes' using errcode = 'insufficient_privilege';
  end if;
  if r.status = 'open' then
    raise exception 'outcome cannot be revealed before the run is locked' using errcode = 'insufficient_privilege';
  end if;
  if r.status = 'locked' then
    update research.evaluation_runs set status = 'revealed', outcome_revealed_by = auth.uid(), outcome_revealed_at = now()
     where id = p_run;
  end if;
  perform audit.log('restricted_read', 'restricted.found_locations', null, r.incident_id, jsonb_build_object('run', p_run));
  return query select f.encrypted_geometry, f.found_at from restricted.found_locations f where f.incident_id = r.incident_id;
end $$;

create or replace function research.record_evaluation_metrics(p_run uuid, p_metrics jsonb) returns void
language plpgsql security definer set search_path = research, audit, pg_temp as $$
declare r research.evaluation_runs;
begin
  select * into r from research.evaluation_runs where id = p_run;
  if not found or not research.can_read_incident(r.incident_id) or not research.has_role('evaluator', 'administrator', 'instructor') then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;
  update research.evaluation_runs set metrics = p_metrics where id = p_run;  -- trigger allows once, after reveal
end $$;

revoke all on function research.lock_evaluation_run(uuid, uuid, uuid[], jsonb, jsonb) from public;
revoke all on function research.reveal_outcome(uuid) from public;
revoke all on function research.record_evaluation_metrics(uuid, jsonb) from public;
revoke all on function audit.log(text, text, text, uuid, jsonb) from public;
grant execute on function research.lock_evaluation_run(uuid, uuid, uuid[], jsonb, jsonb) to authenticated;
grant execute on function research.reveal_outcome(uuid) to authenticated;
grant execute on function research.record_evaluation_metrics(uuid, jsonb) to authenticated;
