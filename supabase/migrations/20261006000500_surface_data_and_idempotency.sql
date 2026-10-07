-- Surface values, grid definitions and idempotency keys for the API.
--
-- Values are stored as one compressed blob per surface (float64 little-endian,
-- gzip) rather than one row per cell. The blob is immutable like its surface.

alter table research.search_domains
  add column grid jsonb not null
    constraint grid_shape check (
      jsonb_typeof(grid -> 'cols') = 'number' and jsonb_typeof(grid -> 'rows') = 'number'
      and jsonb_typeof(grid -> 'cellSize') = 'number' and jsonb_typeof(grid -> 'originX') = 'number'
      and jsonb_typeof(grid -> 'originY') = 'number' and jsonb_typeof(grid -> 'crs') = 'string');

-- No surfaces exist before this migration, so the column can be required.
alter table research.probability_surfaces
  add column search_domain_id uuid not null references research.search_domains(id);

create or replace function research.surface_domain_matches() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from research.search_domains d where d.id = new.search_domain_id and d.incident_id = new.incident_id) then
    raise exception 'search domain belongs to a different incident';
  end if;
  if new.parent_surface_id is not null and not exists (
    select 1 from research.probability_surfaces p where p.id = new.parent_surface_id and p.search_domain_id = new.search_domain_id) then
    raise exception 'an update must stay on its parent''s search domain';
  end if;
  return new;
end $$;

create trigger probability_surfaces_domain before insert on research.probability_surfaces
  for each row execute function research.surface_domain_matches();

create table research.probability_surface_data (
  surface_id uuid primary key references research.probability_surfaces(id),
  storage_format text not null check (storage_format = 'float64-le+gzip'),
  cell_count integer not null check (cell_count > 0),
  data bytea not null
);

create trigger probability_surface_data_immutable before update or delete on research.probability_surface_data
  for each row execute function audit.forbid_change();

alter table research.probability_surface_data enable row level security;
grant select, insert on research.probability_surface_data to authenticated;

create policy surface_data_read on research.probability_surface_data for select to authenticated
  using (exists (select 1 from research.probability_surfaces s where s.id = surface_id));
create policy surface_data_insert on research.probability_surface_data for insert to authenticated
  with check (exists (select 1 from research.probability_surfaces s
                      where s.id = surface_id and s.created_by = auth.uid() and s.locked_at is null));

-- Every mutating API request carries an idempotency key; a replay returns the first response.
create table research.idempotency_keys (
  user_id uuid not null,
  key text not null check (length(key) between 8 and 200),
  operation text not null,
  request_hash text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, key)
);

alter table research.idempotency_keys enable row level security;
grant select, insert on research.idempotency_keys to authenticated;
create policy idempotency_own_read on research.idempotency_keys for select to authenticated using (user_id = auth.uid());
create policy idempotency_own_insert on research.idempotency_keys for insert to authenticated with check (user_id = auth.uid());
