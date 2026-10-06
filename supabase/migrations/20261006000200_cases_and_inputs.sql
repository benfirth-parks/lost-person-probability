-- Cases, subjects, planning inputs, models, clues, assignments and tracks.
-- All timestamps are timestamptz (UTC); local time zone is stored as metadata.
-- Every input that can reach a retrospective run carries available_at so it can be
-- filtered by when planners had it, not when it was observed.

create table research.operating_areas (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  local_time_zone text not null,          -- e.g. America/Edmonton
  local_crs text not null,                -- e.g. EPSG:32611 for distance and area calculations
  extent geography(MultiPolygon, 4326)
);

create table research.model_versions (
  id uuid primary key default gen_random_uuid(),
  component text not null,                -- probability-engine | pod-engine | importer | ...
  version text not null,
  git_commit text,
  created_at timestamptz not null default now(),
  unique (component, version)
);

create table research.search_incidents (
  id uuid primary key default gen_random_uuid(),
  case_code text unique not null,         -- research code, never the source incident number
  mode text not null check (mode in ('retrospective', 'training')),  -- operational rows cannot exist
  incident_type text not null,
  operating_area_id uuid not null references research.operating_areas(id),
  opened_at timestamptz,
  information_cutoff timestamptz not null,
  status text not null,
  coordinate_sensitivity text not null,
  privacy_classification text not null,
  source_system text not null,
  source_record_id text not null,
  source_version text,
  data_completeness jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table research.incident_members (
  incident_id uuid not null references research.search_incidents(id),
  user_id uuid not null references research.application_users(user_id),
  assigned_by uuid,
  assigned_at timestamptz not null default now(),
  primary key (incident_id, user_id)
);

-- Approved structured research fields only. No names, contact details, addresses,
-- medical narratives or family details belong here.
create table research.subjects (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references research.search_incidents(id),
  subject_category text not null,
  age_band text,
  party_size integer check (party_size is null or party_size > 0),
  experience_class text,
  mobility_factors jsonb not null default '{}'::jsonb,
  clothing_visibility_class text,
  research_attributes jsonb not null default '{}'::jsonb
);

create table research.planning_points (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references research.search_incidents(id),
  point_type text not null check (point_type in ('LKP', 'PLS', 'IPP', 'planning_point', 'other')),
  geometry geography(Point, 4326) not null,
  horizontal_uncertainty_m numeric not null check (horizontal_uncertainty_m >= 0),
  observed_at timestamptz,
  available_at timestamptz not null,
  source_type text not null,
  confidence text not null,
  version integer not null default 1,
  supersedes_id uuid references research.planning_points(id)
);

create table research.intended_routes (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references research.search_incidents(id),
  geometry geography(LineString, 4326) not null,
  route_type text not null,
  destination text,
  direction text,
  confidence text not null,
  available_at timestamptz not null,
  version integer not null default 1,
  supersedes_id uuid references research.intended_routes(id)
);

create table research.prior_models (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  model_type text not null,               -- uniform | distance_rings | route_weighted | terrain_reachable
  subject_category text,
  source_description text not null,
  parameters jsonb not null,
  valid_geography text,
  valid_season text,
  sample_size integer,
  version text not null,
  status text not null check (status in ('draft', 'approved_research', 'exercise_only', 'retired')),
  unique (name, version)
);

create table research.pod_models (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  resource_type text not null,
  search_object text not null,
  terrain_class text,
  visibility_class text,
  method text not null,                   -- e.g. exponential-sweep-width@1 | manual
  parameters jsonb not null,
  source_description text not null,
  version text not null,
  status text not null check (status in ('draft', 'approved_research', 'exercise_only', 'retired')),
  unique (name, version)
);

create table research.search_domains (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references research.search_incidents(id),
  geometry geography(MultiPolygon, 4326) not null,
  spatial_representation text not null check (spatial_representation in ('raster', 'vector', 'hybrid')),
  cell_size_m numeric check (cell_size_m is null or cell_size_m > 0),
  coordinate_reference text not null,
  outside_probability numeric not null check (outside_probability >= 0 and outside_probability < 1),
  outside_rationale text not null,
  model_version_id uuid not null references research.model_versions(id),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  constraint domain_geometry_valid check (st_isvalid(geometry::geometry))
);

create table research.terrain_units (
  id uuid primary key default gen_random_uuid(),
  search_domain_id uuid not null references research.search_domains(id),
  unit_key text not null,
  geometry geography(Polygon, 4326) not null,
  area_m2 numeric not null check (area_m2 > 0),
  elevation_summary jsonb,
  slope_summary jsonb,
  landcover_class text,
  travel_cost numeric,
  searchability_class text,
  barrier_flags text[] not null default '{}',
  feature_flags text[] not null default '{}',
  unique (search_domain_id, unit_key)
);
create index terrain_units_geom on research.terrain_units using gist (geometry);

create table research.scenarios (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references research.search_incidents(id),
  name text not null,
  description text not null,
  scenario_weight numeric not null check (scenario_weight >= 0 and scenario_weight <= 1),
  prior_model_id uuid not null references research.prior_models(id),
  planning_point_id uuid not null references research.planning_points(id),
  intended_route_id uuid references research.intended_routes(id),
  parameters jsonb not null,
  rationale text not null check (length(trim(rationale)) > 0),
  status text not null,
  version integer not null default 1,
  supersedes_id uuid references research.scenarios(id),
  created_by uuid not null,
  created_at timestamptz not null default now()
);

create table research.clues (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references research.search_incidents(id),
  clue_type text not null check (clue_type in (
    'witness_sighting', 'device_location', 'track_or_footprint', 'located_item', 'vehicle_or_trailhead',
    'directional_report', 'negative_containment', 'dog_indication', 'subject_communication', 'other')),
  observed_at timestamptz,
  reported_at timestamptz,
  available_at timestamptz not null,
  geometry geography(Geometry, 4326),
  uncertainty jsonb not null,             -- horizontal, vertical, time uncertainty
  source_type text not null,
  source_identifier_code text,
  reliability_class text not null,
  relevance_class text not null,
  standardized_summary text not null,
  restricted_payload_ciphertext text,     -- raw statement, encrypted by the server; never decrypted in the client
  status text not null,
  created_by uuid not null,
  version integer not null default 1,
  supersedes_id uuid references research.clues(id)
);

create table research.clue_likelihood_models (
  id uuid primary key default gen_random_uuid(),
  clue_id uuid not null references research.clues(id),
  method text not null,
  parameters jsonb not null,
  likelihood_storage_uri text,
  minimum_lr numeric not null check (minimum_lr >= 0),
  maximum_lr numeric not null check (maximum_lr >= minimum_lr),
  rationale text not null check (length(trim(rationale)) > 0),
  reviewer_id uuid not null,
  version integer not null default 1
);

create table research.assignments (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references research.search_incidents(id),
  name text not null,
  geometry geography(Polygon, 4326) not null,
  resource_type text not null,
  team_identifier_code text,
  planned_start timestamptz,
  planned_end timestamptz,
  actual_start timestamptz,
  actual_end timestamptz,
  available_at timestamptz not null,      -- when the debrief reached planners
  search_method text not null,
  search_object text not null,
  planned_speed numeric,
  planned_spacing numeric,
  planned_sweep_width numeric,
  planned_pod_method text,
  planned_pod numeric check (planned_pod is null or (planned_pod >= 0 and planned_pod <= 1)),
  achieved_pod numeric check (achieved_pod is null or (achieved_pod >= 0 and achieved_pod <= 1)),
  track_quality text,
  weather_visibility text,
  terrain_searchability text,
  status text not null,
  created_by uuid not null,
  version integer not null default 1,
  supersedes_id uuid references research.assignments(id),
  constraint assignment_geometry_valid check (st_isvalid(geometry::geometry))
);

create table research.search_tracks (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references research.assignments(id),
  raw_geometry geography(LineString, 4326) not null,
  raw_times timestamptz[] ,
  processed_geometry geography(LineString, 4326),
  started_at timestamptz,
  ended_at timestamptz,
  available_at timestamptz not null,
  track_quality text not null,
  quality_flags text[] not null default '{}',
  processing_version text,
  fingerprint text not null,
  source_system text not null,
  source_record_id text not null,
  unique (assignment_id, fingerprint)    -- duplicate uploads are rejected
);

create table research.assignment_pod_surfaces (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references research.assignments(id),
  pod_model_id uuid not null references research.pod_models(id),
  status text not null check (status in ('planned', 'achieved')),
  storage_uri text not null,
  summary_pod numeric not null check (summary_pod >= 0 and summary_pod <= 1),
  coverage numeric,
  input_hash text not null,
  created_by uuid not null,
  created_at timestamptz not null default now()
);
