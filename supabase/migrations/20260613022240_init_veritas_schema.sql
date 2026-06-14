-- Veritas M1 — initial schema (PROJECT_PLAN §4).
--
-- The invariant that is the product: a doc_line's fact_ids must be non-empty AND
-- reference real facts, or the line does not exist. That is enforced here, at the
-- database, in addition to the app-side provenance validation layer (M5) — because
-- the invariant is the product, not a convenience.

-- ── enums ────────────────────────────────────────────────────────────
create type fact_type        as enum ('experience','achievement','skill','education','writing_sample');
create type requirement_kind as enum ('must','nice','responsibility','keyword');
create type coverage_status  as enum ('met','partial','unmet');
create type document_type    as enum ('resume','cover_letter');
create type document_status  as enum ('draft','approved');

-- ── helper: updated_at touch ─────────────────────────────────────────
create function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ── fact ─────────────────────────────────────────────────────────────
create table fact (
  id           uuid primary key default gen_random_uuid(),
  type         fact_type not null,
  content      text not null check (btrim(content) <> ''),
  employer     text,
  role         text,
  date_start   date,
  date_end     date,
  metrics_json jsonb,
  verified     boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint fact_dates_ordered
    check (date_start is null or date_end is null or date_end >= date_start)
);

create trigger fact_set_updated_at
  before update on fact
  for each row execute function set_updated_at();

-- ── job ──────────────────────────────────────────────────────────────
create table job (
  id         uuid primary key default gen_random_uuid(),
  raw_text   text not null check (btrim(raw_text) <> ''),
  company    text,
  title      text,
  created_at timestamptz not null default now()
);

-- ── requirement ──────────────────────────────────────────────────────
create table requirement (
  id     uuid primary key default gen_random_uuid(),
  job_id uuid not null references job (id) on delete cascade,
  text   text not null check (btrim(text) <> ''),
  kind   requirement_kind not null,
  -- lets coverage FK the (requirement_id, job_id) pair, so a coverage row can
  -- never point at a requirement belonging to a different job.
  constraint requirement_id_job_unique unique (id, job_id)
);

create index requirement_job_id_idx on requirement (job_id);

-- ── coverage ─────────────────────────────────────────────────────────
-- Natural composite PK: exactly one assessment per (job, requirement) pair.
create table coverage (
  job_id         uuid not null,
  requirement_id uuid not null,
  status         coverage_status not null,
  fact_ids       uuid[] not null default '{}',
  updated_at     timestamptz not null default now(),
  primary key (job_id, requirement_id),
  constraint coverage_requirement_fk
    foreign key (requirement_id, job_id)
    references requirement (id, job_id) on delete cascade,
  -- met / partial require evidence; unmet requires its absence.
  constraint coverage_evidence_consistent check (
    (status = 'unmet'              and cardinality(fact_ids) = 0)
    or (status in ('met','partial') and cardinality(fact_ids) > 0)
  ),
  constraint coverage_fact_ids_no_nulls
    check (array_position(fact_ids, null) is null)
);

create index coverage_fact_ids_gin on coverage using gin (fact_ids);

create trigger coverage_set_updated_at
  before update on coverage
  for each row execute function set_updated_at();

-- ── document ─────────────────────────────────────────────────────────
create table document (
  id         uuid primary key default gen_random_uuid(),
  job_id     uuid not null references job (id) on delete cascade,
  type       document_type not null,
  status     document_status not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index document_job_id_idx on document (job_id);

create trigger document_set_updated_at
  before update on document
  for each row execute function set_updated_at();

-- ── doc_line — the invariant that is the product ─────────────────────
-- cardinality(), NOT array_length(): array_length('{}',1) returns NULL, and a
-- CHECK that evaluates to NULL PASSES — that trap would let empty arrays through.
create table doc_line (
  id          uuid primary key default gen_random_uuid(),
  document_id uuid not null references document (id) on delete cascade,
  text        text not null check (btrim(text) <> ''),
  fact_ids    uuid[] not null,
  approved    boolean not null default false,
  position    integer not null default 0,  -- line order within the document
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint doc_line_fact_ids_not_empty check (cardinality(fact_ids) > 0),
  constraint doc_line_fact_ids_no_nulls  check (array_position(fact_ids, null) is null)
);

create index doc_line_document_position_idx on doc_line (document_id, position);
create index doc_line_fact_ids_gin on doc_line using gin (fact_ids);

create trigger doc_line_set_updated_at
  before update on doc_line
  for each row execute function set_updated_at();

-- ── element-level referential integrity for fact_ids[] ───────────────
-- Postgres cannot foreign-key the elements of an array, so these triggers close
-- the gap in both directions. Known limit: BEFORE triggers do not take the
-- row locks a real FK would, so a concurrent cite-while-delete race exists under
-- READ COMMITTED. Acceptable for a single-user local app; revisit if multi-user.

-- Direction 1: every cited fact id must reference an existing fact.
create function assert_fact_ids_exist() returns trigger
language plpgsql as $$
declare
  missing uuid;
begin
  select fid into missing
  from unnest(new.fact_ids) as fid
  where not exists (select 1 from fact where fact.id = fid)
  limit 1;
  if missing is not null then
    raise exception 'fact_ids references nonexistent fact %', missing
      using errcode = '23503';  -- foreign_key_violation
  end if;
  return new;
end;
$$;

create trigger doc_line_fact_ids_exist
  before insert or update of fact_ids on doc_line
  for each row execute function assert_fact_ids_exist();

create trigger coverage_fact_ids_exist
  before insert or update of fact_ids on coverage
  for each row execute function assert_fact_ids_exist();

-- Direction 2: a cited fact cannot be deleted or have its id re-keyed.
create function protect_cited_fact() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.id = old.id then
    return new;  -- non-id update, nothing to protect
  end if;
  if exists (select 1 from doc_line where old.id = any (fact_ids))
     or exists (select 1 from coverage where old.id = any (fact_ids)) then
    raise exception 'fact % is cited and cannot be deleted or re-keyed', old.id
      using errcode = '23503';
  end if;
  if tg_op = 'UPDATE' then
    return new;
  end if;
  return old;
end;
$$;

create trigger fact_protect_citations
  before delete or update of id on fact
  for each row execute function protect_cited_fact();

-- Deliberately NOT enforced here: "a doc_line may cite only VERIFIED facts."
-- Drafts may legitimately cite not-yet-verified facts while authoring; the
-- provenance validation layer (src/lib/provenance/) enforces verification at
-- approval time (M5).

-- ── row level security — deny-by-default for the public API roles ────
-- Every table holds personal career data (facts, job text, generated docs and
-- their evidence). Supabase exposes the `anon` and `authenticated` roles over
-- its public REST/Realtime API; without RLS, anyone with the (publishable) anon
-- key could read or write all of it. So we enable RLS and add NO policies: with
-- RLS on and zero policies, every row is denied to those roles — deny-by-default.
--
-- The app reaches the database only through the server-side service-role client
-- (src/lib/db/client.ts). The Supabase `service_role` carries the BYPASSRLS
-- attribute, so server-side access is unaffected. The provenance triggers and
-- CHECK constraints above also continue to fire — RLS filters which rows a role
-- may touch; it does not disable triggers or constraints.
--
-- When real multi-user auth arrives, add explicit per-user policies then; do not
-- loosen this default to get the browser talking to the DB directly.
alter table fact        enable row level security;
alter table job         enable row level security;
alter table requirement enable row level security;
alter table coverage    enable row level security;
alter table document    enable row level security;
alter table doc_line    enable row level security;
