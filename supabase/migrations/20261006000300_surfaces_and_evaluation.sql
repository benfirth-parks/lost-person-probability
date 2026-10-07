-- Immutable probability surfaces, update records, manual adjustments,
-- restricted outcomes and locked evaluation runs.

create table research.probability_surfaces (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references research.search_incidents(id),
  iteration integer not null check (iteration >= 0),
  parent_surface_id uuid references research.probability_surfaces(id),
  surface_type text not null check (surface_type in ('prior', 'clue_update', 'search_update', 'manual_adjustment', 'rollback')),
  storage_uri text,
  storage_format text not null,           -- e.g. float64-le+gzip
  values_hash text not null,
  in_domain_probability numeric not null check (in_domain_probability >= 0 and in_domain_probability <= 1),
  outside_domain_probability numeric not null check (outside_domain_probability >= 0 and outside_domain_probability <= 1),
  normalization_constant numeric not null check (normalization_constant > 0),
  probability_sum numeric not null check (abs(probability_sum - 1) <= 1e-10),
  model_version_id uuid not null references research.model_versions(id),
  input_hash text not null,
  rationale text not null default '',
  created_by uuid not null,
  created_at timestamptz not null default now(),
  locked_at timestamptz,
  constraint prior_has_no_parent check ((surface_type = 'prior') = (parent_surface_id is null)),
  constraint update_has_rationale check (surface_type = 'prior' or length(trim(rationale)) > 0),
  constraint mass_adds_up check (abs(in_domain_probability + outside_domain_probability - probability_sum) <= 1e-10)
);
create index probability_surfaces_incident on research.probability_surfaces (incident_id, iteration);

-- Surfaces are append-only. The only permitted change is setting locked_at once.
create or replace function research.surface_immutable() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'probability surfaces cannot be deleted' using errcode = 'insufficient_privilege';
  end if;
  if old.locked_at is null and new.locked_at is not null
     and (to_jsonb(new) - 'locked_at') = (to_jsonb(old) - 'locked_at') then
    return new;
  end if;
  raise exception 'probability surfaces are immutable; create a new iteration instead' using errcode = 'insufficient_privilege';
end $$;

create trigger probability_surfaces_immutable before update or delete on research.probability_surfaces
  for each row execute function research.surface_immutable();

-- Iteration must follow the parent and stay within the same incident.
create or replace function research.surface_lineage() returns trigger
language plpgsql as $$
declare p record;
begin
  if new.parent_surface_id is null then
    if new.iteration <> 0 then raise exception 'a prior must be iteration 0'; end if;
    return new;
  end if;
  select incident_id, iteration into p from research.probability_surfaces where id = new.parent_surface_id;
  if p.incident_id is distinct from new.incident_id then
    raise exception 'parent surface belongs to a different incident';
  end if;
  if new.iteration <> p.iteration + 1 then
    raise exception 'iteration must be parent iteration + 1 (expected %)', p.iteration + 1;
  end if;
  return new;
end $$;

create trigger probability_surfaces_lineage before insert on research.probability_surfaces
  for each row execute function research.surface_lineage();

create table research.probability_unit_values (
  surface_id uuid not null references research.probability_surfaces(id),
  terrain_unit_id uuid not null references research.terrain_units(id),
  probability double precision not null check (probability >= 0 and probability <= 1),
  probability_density double precision,
  scenario_contributions jsonb,
  primary key (surface_id, terrain_unit_id)
);

create table research.probability_updates (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references research.search_incidents(id),
  prior_surface_id uuid not null references research.probability_surfaces(id),
  posterior_surface_id uuid not null unique references research.probability_surfaces(id),
  update_type text not null,
  evidence_type text not null,
  evidence_id uuid not null,
  method text not null,
  parameters jsonb not null,
  rationale text not null check (length(trim(rationale)) > 0),
  preview_hash text not null,
  committed_by uuid not null,
  committed_at timestamptz not null default now()
);

create table research.manual_adjustments (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references research.search_incidents(id),
  prior_surface_id uuid not null references research.probability_surfaces(id),
  posterior_surface_id uuid not null unique references research.probability_surfaces(id),
  adjustment_geometry geography(Geometry, 4326),
  adjustment_method text not null,
  parameters jsonb not null,
  rationale text not null check (length(trim(rationale)) >= 10),
  approved_by uuid not null,
  created_at timestamptz not null default now()
);

create trigger probability_updates_append_only before update or delete on research.probability_updates
  for each row execute function audit.forbid_change();
create trigger manual_adjustments_append_only before update or delete on research.manual_adjustments
  for each row execute function audit.forbid_change();

-- ---------------------------------------------------------------------------
-- Restricted outcomes
-- ---------------------------------------------------------------------------

-- Ciphertext only. The decryption key lives in the server function environment,
-- never in the database, the client bundle, or source control.
create table restricted.found_locations (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null unique references research.search_incidents(id),
  encrypted_geometry text not null,
  found_at timestamptz,
  source_system text not null,
  source_record_id text not null,
  access_class text not null
);
revoke all on restricted.found_locations from public;

-- ---------------------------------------------------------------------------
-- Evaluation runs
-- ---------------------------------------------------------------------------

create table research.evaluation_runs (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references research.search_incidents(id),
  information_cutoff timestamptz not null,
  locked_surface_id uuid references research.probability_surfaces(id),
  baseline_surface_ids uuid[] not null default '{}',
  model_versions jsonb not null default '{}'::jsonb,
  input_hashes jsonb not null default '{}'::jsonb,
  created_by uuid not null,
  locked_by uuid,
  locked_at timestamptz,
  outcome_revealed_by uuid,
  outcome_revealed_at timestamptz,
  metrics jsonb,
  status text not null default 'open' check (status in ('open', 'locked', 'revealed')),
  constraint locked_fields check ((status = 'open') = (locked_at is null)
    and (status = 'open' or (locked_surface_id is not null and locked_by is not null))),
  constraint revealed_fields check ((status = 'revealed') = (outcome_revealed_at is not null))
);

-- Allowed transitions: open → locked → revealed; metrics may be written once after reveal.
create or replace function research.evaluation_transition() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'evaluation runs cannot be deleted'; end if;
  if old.status = 'open' and new.status in ('open', 'locked') then return new; end if;
  if old.status = 'locked' and new.status = 'revealed'
     and new.locked_surface_id = old.locked_surface_id and new.locked_at = old.locked_at then return new; end if;
  if old.status = 'revealed' and new.status = 'revealed' and old.metrics is null
     and (to_jsonb(new) - 'metrics') = (to_jsonb(old) - 'metrics') then return new; end if;
  raise exception 'evaluation run cannot change from % to % this way', old.status, new.status;
end $$;

create trigger evaluation_runs_transition before update or delete on research.evaluation_runs
  for each row execute function research.evaluation_transition();
