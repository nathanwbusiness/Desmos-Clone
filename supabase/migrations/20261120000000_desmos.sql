-- Desmos workspace store (part of the shared "Vibes" Supabase project).
--
-- Everything lives in its own `desmos` schema, separate from other apps in the
-- project. Supabase's REST API only exposes the `public` schema, so nothing here
-- is reachable from the web except through the `desmos-bridge` Edge Function (which
-- checks a personal key) and through direct SQL (how Claude edits graphs).

create schema if not exists desmos;

-- One row per linked graph. `state` is exactly what Calc.getState() returns.
create table if not exists desmos.graphs (
  id               uuid primary key default gen_random_uuid(),
  name             text not null default 'Untitled graph',
  calculator       text not null default 'graphing'
                   check (calculator in ('graphing', '3d', 'geometry')),
  desmos_hash      text unique,            -- id in desmos.com/calculator/<hash>; null until saved there
  state            jsonb not null,
  version          integer not null default 1,
  updated_by       text not null default 'nathan'
                   check (updated_by in ('nathan', 'claude')),
  note             text,                   -- one line about the latest change
  bridge_status    text,                   -- last result reported by the browser bridge
  bridge_status_at timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Every state a graph has ever had, so any change can be rolled back.
create table if not exists desmos.graph_versions (
  graph_id   uuid not null references desmos.graphs(id) on delete cascade,
  version    integer not null,
  state      jsonb not null,
  updated_by text not null,
  note       text,
  created_at timestamptz not null default now(),
  primary key (graph_id, version)
);

-- Version numbers only move when the state changes. Name, hash and status
-- updates keep the version, so the bridge doesn't treat them as new content.
create or replace function desmos.graphs_before_write() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    new.created_at := old.created_at;
    if new.state is distinct from old.state then
      new.version := old.version + 1;
      new.updated_at := now();
    else
      new.version := old.version;
      new.updated_by := old.updated_by;
      new.note := old.note;
      new.updated_at := old.updated_at;
    end if;
  else
    new.version := 1;
    new.updated_at := now();
  end if;
  return new;
end $$;

create or replace function desmos.graphs_after_write() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' or new.state is distinct from old.state then
    insert into desmos.graph_versions (graph_id, version, state, updated_by, note)
    values (new.id, new.version, new.state, new.updated_by, new.note);
  end if;
  return null;
end $$;

create or replace trigger graphs_before_write
  before insert or update on desmos.graphs
  for each row execute function desmos.graphs_before_write();

create or replace trigger graphs_after_write
  after insert or update on desmos.graphs
  for each row execute function desmos.graphs_after_write();

-- ---------------------------------------------------------------------------
-- Helpers for Claude. Each returns the graph's new version number.
-- ---------------------------------------------------------------------------

-- Replace a graph's whole state.
create or replace function desmos.claude_set_state(p_graph uuid, p_state jsonb, p_note text)
returns integer language plpgsql set search_path = '' as $$
declare v integer;
begin
  if jsonb_typeof(p_state -> 'expressions' -> 'list') is distinct from 'array' then
    raise exception 'state.expressions.list must be an array';
  end if;
  update desmos.graphs
     set state = p_state, updated_by = 'claude', note = p_note
   where id = p_graph
  returning version into v;
  if v is null then raise exception 'graph % not found', p_graph; end if;
  return v;
end $$;

-- Add an expression, or replace the one with the same id.
-- p_after_id: when adding, insert right after this expression id (null = at the end).
create or replace function desmos.claude_put_expression(
  p_graph uuid, p_expr jsonb, p_note text, p_after_id text default null)
returns integer language plpgsql set search_path = '' as $$
declare
  s jsonb;
  list jsonb;
  idx integer;
  after_idx integer;
begin
  if p_expr ->> 'id' is null or p_expr ->> 'type' is null then
    raise exception 'expression needs an id and a type';
  end if;
  select state into s from desmos.graphs where id = p_graph for update;
  if s is null then raise exception 'graph % not found', p_graph; end if;
  list := coalesce(s -> 'expressions' -> 'list', '[]'::jsonb);

  select (e.ord - 1)::int into idx
    from jsonb_array_elements(list) with ordinality as e(x, ord)
   where e.x ->> 'id' = p_expr ->> 'id';

  if idx is not null then
    list := jsonb_set(list, array[idx::text], p_expr);
  elsif p_after_id is not null then
    select (e.ord - 1)::int into after_idx
      from jsonb_array_elements(list) with ordinality as e(x, ord)
     where e.x ->> 'id' = p_after_id;
    if after_idx is null then raise exception 'expression % not found', p_after_id; end if;
    list := jsonb_insert(list, array[after_idx::text], p_expr, true);
  else
    list := list || jsonb_build_array(p_expr);
  end if;

  return desmos.claude_set_state(p_graph, jsonb_set(s, '{expressions,list}', list, true), p_note);
end $$;

-- Remove one expression by id.
create or replace function desmos.claude_remove_expression(p_graph uuid, p_expr_id text, p_note text)
returns integer language plpgsql set search_path = '' as $$
declare
  s jsonb;
  list jsonb;
begin
  select state into s from desmos.graphs where id = p_graph for update;
  if s is null then raise exception 'graph % not found', p_graph; end if;
  select coalesce(jsonb_agg(e.x order by e.ord), '[]'::jsonb) into list
    from jsonb_array_elements(s -> 'expressions' -> 'list') with ordinality as e(x, ord)
   where e.x ->> 'id' is distinct from p_expr_id;
  if jsonb_array_length(list) = jsonb_array_length(s -> 'expressions' -> 'list') then
    raise exception 'expression % not found', p_expr_id;
  end if;
  return desmos.claude_set_state(p_graph, jsonb_set(s, '{expressions,list}', list), p_note);
end $$;

-- Start a new graph. It appears in the bridge's graph list, ready to open on desmos.com.
create or replace function desmos.claude_new_graph(
  p_name text, p_state jsonb, p_note text, p_calculator text default 'graphing')
returns uuid language plpgsql set search_path = '' as $$
declare new_id uuid;
begin
  insert into desmos.graphs (name, calculator, state, updated_by, note)
  values (p_name, p_calculator, p_state, 'claude', p_note)
  returning id into new_id;
  return new_id;
end $$;

-- Put an older version back as the newest one. Nothing is deleted.
create or replace function desmos.restore_version(p_graph uuid, p_version integer, p_by text)
returns integer language plpgsql set search_path = '' as $$
declare
  old_state jsonb;
  v integer;
begin
  select state into old_state from desmos.graph_versions
   where graph_id = p_graph and version = p_version;
  if old_state is null then raise exception 'version % of graph % not found', p_version, p_graph; end if;
  update desmos.graphs
     set state = old_state, updated_by = p_by, note = 'Restored version ' || p_version
   where id = p_graph
  returning version into v;
  return v;
end $$;

-- ---------------------------------------------------------------------------
-- Lock down. A new schema grants nothing to Supabase's `anon` and
-- `authenticated` roles, and the REST API doesn't expose it. Row level security
-- with no policies is a second lock: only the table owner (the Edge Function
-- and Claude connect as the owner) can read or write.
-- ---------------------------------------------------------------------------
alter table desmos.graphs enable row level security;
alter table desmos.graph_versions enable row level security;
