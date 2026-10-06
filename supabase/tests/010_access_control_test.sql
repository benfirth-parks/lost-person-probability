-- Access-control, leakage and immutability tests.
-- Runs as the migration owner to seed, then impersonates each role with
-- SET LOCAL ROLE authenticated + a JWT subject, exactly as PostgREST does.

\set ON_ERROR_STOP 1
set client_min_messages = warning;

-- Fixed ids keep the script readable.
-- users: a1 admin, e1 evaluator, t1 trainee (member), t2 trainee (not a member), n1 analyst, x1 unknown
begin;
insert into research.application_users (user_id, display_code, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin-01', 'administrator'),
  ('00000000-0000-0000-0000-0000000000e1', 'evaluator-01', 'evaluator'),
  ('00000000-0000-0000-0000-0000000000c1', 'trainee-01', 'planner_trainee'),
  ('00000000-0000-0000-0000-0000000000c2', 'trainee-02', 'planner_trainee'),
  ('00000000-0000-0000-0000-0000000000b1', 'analyst-01', 'analyst');
insert into research.operating_areas (id, code, name, local_time_zone, local_crs) values
  ('10000000-0000-0000-0000-000000000001', 'EX', 'Exercise area', 'America/Edmonton', 'EPSG:32611');
insert into research.model_versions (id, component, version) values
  ('20000000-0000-0000-0000-000000000001', 'probability-engine', '0.1.0');
insert into research.search_incidents (id, case_code, mode, incident_type, operating_area_id, information_cutoff, status,
  coordinate_sensitivity, privacy_classification, source_system, source_record_id) values
  ('30000000-0000-0000-0000-000000000001', 'RT-TEST-01', 'retrospective', 'overdue_hiker', '10000000-0000-0000-0000-000000000001',
   '2026-07-18 22:00:00+00', 'ready', 'restricted', 'deidentified', 'fixture', 'fx-1');
insert into research.incident_members (incident_id, user_id) values
  ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c1'),
  ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000e1');
insert into research.clues (id, incident_id, clue_type, available_at, geometry, uncertainty, source_type, reliability_class,
  relevance_class, standardized_summary, restricted_payload_ciphertext, status, created_by) values
  ('40000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'witness_sighting', '2026-07-18 20:10:00+00',
   'SRID=4326;POINT(-116.2 51.4)', '{"horizontal_m":150}', 'witness', 'B', 'medium', 'Sighting at creek crossing', 'ciphertext-1', 'active',
   '00000000-0000-0000-0000-0000000000a1'),
  ('40000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000001', 'located_item', '2026-07-19 00:40:00+00',
   'SRID=4326;POINT(-116.21 51.41)', '{"horizontal_m":20}', 'team', 'A', 'high', 'Item found upstream', null, 'active',
   '00000000-0000-0000-0000-0000000000a1');
insert into restricted.found_locations (incident_id, encrypted_geometry, source_system, source_record_id, access_class) values
  ('30000000-0000-0000-0000-000000000001', 'v1:sealed-outcome-ciphertext', 'fixture', 'fx-1', 'protected_outcome');
commit;

-- Helper to switch identity inside a transaction.
create or replace function pg_temp.act_as(p_user text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_user, true);
$$;

-- ---------------------------------------------------------------------------
-- Anonymous callers get nothing.
-- ---------------------------------------------------------------------------
begin;
set local role anon;
do $$ begin
  begin
    perform 1 from research.search_incidents;
    raise exception 'FAIL anon could read incidents';
  exception when insufficient_privilege then null;
  end;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- Trainee (member): sees the case, only pre-cutoff clues, no ciphertext,
-- cannot touch restricted data or reveal outcomes.
-- ---------------------------------------------------------------------------
begin;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
set local role authenticated;
do $$ begin
  assert (select count(*) from research.search_incidents) = 1, 'FAIL trainee should see assigned case';
  assert (select count(*) from research.clues) = 1, 'FAIL trainee must not see clues available after the cutoff';
  assert (select id from research.clues) = '40000000-0000-0000-0000-000000000001', 'FAIL wrong clue visible';
  begin
    perform restricted_payload_ciphertext from research.clues;
    raise exception 'FAIL trainee could read raw clue ciphertext';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from restricted.found_locations;
    raise exception 'FAIL trainee could query restricted outcomes';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from audit.audit_events;
    raise exception 'FAIL trainee could read the audit log';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Trainee commits a prior surface and an update.
insert into research.probability_surfaces (id, incident_id, iteration, surface_type, storage_format, values_hash,
  in_domain_probability, outside_domain_probability, normalization_constant, probability_sum, model_version_id, input_hash, created_by)
values ('50000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 0, 'prior', 'float64-le+gzip', 'h0',
  0.9, 0.1, 1, 1, '20000000-0000-0000-0000-000000000001', 'i0', '00000000-0000-0000-0000-0000000000c1');
insert into research.probability_surfaces (id, incident_id, iteration, parent_surface_id, surface_type, storage_format, values_hash,
  in_domain_probability, outside_domain_probability, normalization_constant, probability_sum, model_version_id, input_hash, rationale, created_by)
values ('50000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000001', 1, '50000000-0000-0000-0000-000000000001',
  'clue_update', 'float64-le+gzip', 'h1', 0.92, 0.08, 1.3, 1, '20000000-0000-0000-0000-000000000001', 'i1',
  'Witness credible', '00000000-0000-0000-0000-0000000000c1');

do $$ begin
  -- Cannot write as someone else.
  begin
    insert into research.probability_surfaces (incident_id, iteration, surface_type, storage_format, values_hash,
      in_domain_probability, outside_domain_probability, normalization_constant, probability_sum, model_version_id, input_hash, created_by)
    values ('30000000-0000-0000-0000-000000000001', 0, 'prior', 'f', 'h', 1, 0, 1, 1, '20000000-0000-0000-0000-000000000001', 'i',
            '00000000-0000-0000-0000-0000000000e1');
    raise exception 'FAIL trainee wrote a surface as another user';
  exception when insufficient_privilege then null;
  end;
  -- Probabilities must add up.
  begin
    insert into research.probability_surfaces (incident_id, iteration, surface_type, storage_format, values_hash,
      in_domain_probability, outside_domain_probability, normalization_constant, probability_sum, model_version_id, input_hash, created_by)
    values ('30000000-0000-0000-0000-000000000001', 0, 'prior', 'f', 'h', 0.9, 0.2, 1, 1.1, '20000000-0000-0000-0000-000000000001', 'i',
            '00000000-0000-0000-0000-0000000000c1');
    raise exception 'FAIL surface with probability sum 1.1 accepted';
  exception when check_violation then null;
  end;
  -- Iteration must follow the parent.
  begin
    insert into research.probability_surfaces (incident_id, iteration, parent_surface_id, surface_type, storage_format, values_hash,
      in_domain_probability, outside_domain_probability, normalization_constant, probability_sum, model_version_id, input_hash, rationale, created_by)
    values ('30000000-0000-0000-0000-000000000001', 5, '50000000-0000-0000-0000-000000000001', 'search_update', 'f', 'h', 1, 0, 1, 1,
            '20000000-0000-0000-0000-000000000001', 'i', 'no find', '00000000-0000-0000-0000-0000000000c1');
    raise exception 'FAIL out-of-sequence iteration accepted';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
  -- Updates need a rationale.
  begin
    insert into research.probability_surfaces (incident_id, iteration, parent_surface_id, surface_type, storage_format, values_hash,
      in_domain_probability, outside_domain_probability, normalization_constant, probability_sum, model_version_id, input_hash, created_by)
    values ('30000000-0000-0000-0000-000000000001', 1, '50000000-0000-0000-0000-000000000001', 'search_update', 'f', 'h', 1, 0, 1, 1,
            '20000000-0000-0000-0000-000000000001', 'i', '00000000-0000-0000-0000-0000000000c1');
    raise exception 'FAIL update without rationale accepted';
  exception when check_violation then null;
  end;
  -- No in-place edits.
  begin
    update research.probability_surfaces set outside_domain_probability = 0.5 where id = '50000000-0000-0000-0000-000000000001';
    raise exception 'FAIL trainee updated a surface';
  exception when insufficient_privilege then null;
  end;
  -- Trainee cannot open or lock an evaluation run.
  begin
    insert into research.evaluation_runs (incident_id, information_cutoff, created_by)
    values ('30000000-0000-0000-0000-000000000001', '2026-07-18 22:00:00+00', '00000000-0000-0000-0000-0000000000c1');
    raise exception 'FAIL trainee created an evaluation run';
  exception when insufficient_privilege then null;
  end;
end $$;
commit;

-- Even the owner cannot edit or delete a surface.
do $$ begin
  begin
    update research.probability_surfaces set rationale = 'x' where id = '50000000-0000-0000-0000-000000000002';
    raise exception 'FAIL owner edited a surface';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from research.probability_surfaces where id = '50000000-0000-0000-0000-000000000002';
    raise exception 'FAIL owner deleted a surface';
  exception when insufficient_privilege then null;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- Trainee who is not a member sees nothing.
-- ---------------------------------------------------------------------------
begin;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c2');
set local role authenticated;
do $$ begin
  assert (select count(*) from research.search_incidents) = 0, 'FAIL non-member trainee sees a case';
  assert (select count(*) from research.probability_surfaces) = 0, 'FAIL non-member trainee sees surfaces';
  assert (select count(*) from research.clues) = 0, 'FAIL non-member trainee sees clues';
end $$;
rollback;

-- Unknown user (valid JWT, no application role) sees nothing.
begin;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000ff');
set local role authenticated;
do $$ begin
  assert (select count(*) from research.search_incidents) = 0, 'FAIL unregistered user sees a case';
  assert (select count(*) from research.application_roles) = 0, 'FAIL unregistered user sees reference data';
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- Evaluation workflow: no reveal before lock; trainee cannot reveal; evaluator can after lock.
-- ---------------------------------------------------------------------------
begin;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e1');
set local role authenticated;
do $$ begin
  assert (select count(*) from research.clues) = 2, 'FAIL evaluator should see the full timeline';
end $$;
insert into research.evaluation_runs (id, incident_id, information_cutoff, created_by)
values ('60000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '2026-07-18 22:00:00+00',
        '00000000-0000-0000-0000-0000000000e1');
do $$ begin
  begin
    perform * from research.reveal_outcome('60000000-0000-0000-0000-000000000001');
    raise exception 'FAIL outcome revealed before lock';
  exception when insufficient_privilege then null;
  end;
  begin
    update research.evaluation_runs set status = 'revealed' where id = '60000000-0000-0000-0000-000000000001';
    raise exception 'FAIL evaluator changed run status directly';
  exception when insufficient_privilege then null;
  end;
end $$;
select status from research.lock_evaluation_run('60000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000002',
  '{}', '{"probability-engine":"0.1.0"}', '{}');
commit;

begin;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
set local role authenticated;
do $$ begin
  begin
    perform * from research.reveal_outcome('60000000-0000-0000-0000-000000000001');
    raise exception 'FAIL trainee revealed an outcome';
  exception when insufficient_privilege then null;
  end;
end $$;
rollback;

begin;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e1');
set local role authenticated;
do $$ begin
  assert (select encrypted_geometry from research.reveal_outcome('60000000-0000-0000-0000-000000000001')) = 'v1:sealed-outcome-ciphertext',
    'FAIL evaluator could not reveal after lock';
  assert (select status from research.evaluation_runs where id = '60000000-0000-0000-0000-000000000001') = 'revealed',
    'FAIL run not marked revealed';
end $$;
select research.record_evaluation_metrics('60000000-0000-0000-0000-000000000001', '{"log_score": -5.1}');
do $$ begin
  begin
    perform research.record_evaluation_metrics('60000000-0000-0000-0000-000000000001', '{"log_score": 0}');
    raise exception 'FAIL metrics overwritten';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
end $$;
commit;

-- Locked surface stays locked and immutable; reveal and restricted read are audited.
do $$ begin
  assert (select locked_at is not null from research.probability_surfaces where id = '50000000-0000-0000-0000-000000000002'),
    'FAIL locked surface has no locked_at';
  assert (select count(*) from audit.audit_events where action = 'restricted_read') = 1, 'FAIL restricted read not audited';
  assert (select count(*) from audit.audit_events where action = 'lock') = 1, 'FAIL lock not audited';
  assert (select count(*) from audit.audit_events where table_name = 'research.probability_surfaces' and action = 'insert') = 2,
    'FAIL surface inserts not audited';
  begin
    delete from audit.audit_events;
    raise exception 'FAIL audit log deleted';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Operational mode cannot be switched on, operational roles cannot be enabled, operational incidents cannot exist.
do $$ begin
  begin
    update research.feature_flags set enabled = true where key = 'operational_mode';
    raise exception 'FAIL operational mode enabled';
  exception when check_violation then null;
  end;
  begin
    update research.application_roles set enabled = true where role = 'operational_search_manager';
    raise exception 'FAIL operational role enabled';
  exception when check_violation then null;
  end;
  begin
    insert into research.search_incidents (case_code, mode, incident_type, operating_area_id, information_cutoff, status,
      coordinate_sensitivity, privacy_classification, source_system, source_record_id)
    values ('OP-1', 'operational_disabled', 'x', '10000000-0000-0000-0000-000000000001', now(), 's', 'c', 'p', 's', 'r');
    raise exception 'FAIL operational incident created';
  exception when check_violation then null;
  end;
end $$;

-- Analyst can read the case but not write surfaces.
begin;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
set local role authenticated;
do $$ begin
  assert (select count(*) from research.search_incidents) = 1, 'FAIL analyst cannot read case';
  begin
    insert into research.probability_surfaces (incident_id, iteration, surface_type, storage_format, values_hash,
      in_domain_probability, outside_domain_probability, normalization_constant, probability_sum, model_version_id, input_hash, created_by)
    values ('30000000-0000-0000-0000-000000000001', 0, 'prior', 'f', 'h', 1, 0, 1, 1, '20000000-0000-0000-0000-000000000001', 'i',
            '00000000-0000-0000-0000-0000000000b1');
    raise exception 'FAIL analyst wrote a surface';
  exception when insufficient_privilege then null;
  end;
end $$;
rollback;

select 'access-control tests passed';
