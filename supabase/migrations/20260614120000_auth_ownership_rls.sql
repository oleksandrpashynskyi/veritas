-- ─────────────────────────────────────────────────────────────────────────────
-- Auth Foundation (M1.5): per-user ownership + RLS for the `authenticated` role
-- ─────────────────────────────────────────────────────────────────────────────
-- M1 enabled RLS deny-by-default (RLS on, ZERO policies) on all six tables, so the
-- public `anon`/`authenticated` API roles could touch nothing and the app reached
-- Postgres only through the service-role client (BYPASSRLS). This migration begins
-- multi-user auth: career data is now OWNED by an `auth.users` row, and the
-- `authenticated` role may touch ONLY rows it owns.
--
-- What does NOT change:
--   * `anon` stays fully denied — every policy below is `to authenticated`, so anon
--     keeps zero applicable policies (deny-by-default preserved).
--   * The app still reaches the DB via the service-role client (BYPASSRLS); these
--     policies govern the PUBLIC API surface (a leaked anon key, or a future per-user
--     authenticated client). The per-user app data path + login UI are deferred.
--   * Provenance is untouched: the doc_line/coverage fact_ids CHECKs and the
--     assert_fact_ids_exist() / protect_cited_fact() triggers still fire. RLS filters
--     which rows a role may touch; it does not disable constraints or triggers.
--
-- Ownership model — only the two ROOT tables carry an owner:
--   * fact — master-profile facts (owned directly)
--   * job  — a pasted job posting (owned directly)
-- The four descendants inherit ownership through their existing FK chains, expressed
-- in RLS via EXISTS against the owned parent:
--   * requirement.job_id   -> job                          (one hop)
--   * coverage.job_id      -> job                          (one hop)
--   * document.job_id      -> job                          (one hop)
--   * doc_line.document_id -> document.job_id -> job       (two hops)
-- Single source of truth; ownership-skew is structurally impossible — a child has no
-- owner column of its own to disagree with its parent.
--
-- `owner` is added NOT NULL with no default, which requires the two root tables to be
-- empty (true on a fresh `supabase db reset`). A hosted deploy with existing rows must
-- backfill an owner first — out of scope for this local proof.
--
-- Table-level DML privileges for `authenticated` come from Supabase's default grants
-- on the public schema; the security proof's positive-control writes verify that
-- assumption empirically. If a future environment lacks those defaults, add explicit
-- `grant`s here — never loosen the per-row policies to compensate.

-- ── ownership columns on the roots ───────────────────────────────────────────
alter table fact add column owner uuid not null references auth.users (id) on delete cascade;
alter table job  add column owner uuid not null references auth.users (id) on delete cascade;

create index fact_owner_idx on fact (owner);
create index job_owner_idx  on job  (owner);

-- ── table privileges — explicit, do NOT rely on Supabase's default grants ─────
-- First STRIP the public API roles — `anon`, and the `public` pseudo-role every role
-- inherits — to NOTHING on these tables; THEN grant DML to `authenticated` ONLY. So
-- anon's denial now rests on TWO independent layers: no table privilege (this REVOKE)
-- AND no row policy (the RLS below) — not RLS alone. `authenticated` keeps access via
-- its explicit grant; `service_role` keeps its own Supabase grant (+ BYPASSRLS) and is
-- untouched here. The proof's anon-denial checks, the authenticated positive controls,
-- and the service-role seeding together are the regression proving this revoke denied
-- anon and broke neither other path. (PKs are uuid defaults — no sequence grants.)
revoke all on fact, job, requirement, coverage, document, doc_line from anon, public;
grant select, insert, update, delete
  on fact, job, requirement, coverage, document, doc_line
  to authenticated;

-- ── RLS: the authenticated role may touch only what it owns ───────────────────
-- `(select auth.uid())` (sub-select form) lets the planner evaluate auth.uid() once
-- per statement instead of once per row (Supabase RLS performance guidance).
--
-- Per-command semantics that the proof depends on:
--   SELECT  — USING filters rows out silently (no error).
--   INSERT  — WITH CHECK on the new row; a violation is a hard error (SQLSTATE 42501).
--   UPDATE  — USING picks targetable rows (a non-owned row is filtered to a silent
--             no-op); WITH CHECK guards the new image, so re-owning a row you DO own
--             is a hard error (42501).
--   DELETE  — USING picks targetable rows (a non-owned row is a silent no-op).

-- fact (root) ─────────────────────────────────────────────────────────────────
create policy fact_select_own on fact for select to authenticated
  using ((select auth.uid()) = owner);
create policy fact_insert_own on fact for insert to authenticated
  with check ((select auth.uid()) = owner);
create policy fact_update_own on fact for update to authenticated
  using ((select auth.uid()) = owner)
  with check ((select auth.uid()) = owner);
create policy fact_delete_own on fact for delete to authenticated
  using ((select auth.uid()) = owner);

-- job (root) ──────────────────────────────────────────────────────────────────
create policy job_select_own on job for select to authenticated
  using ((select auth.uid()) = owner);
create policy job_insert_own on job for insert to authenticated
  with check ((select auth.uid()) = owner);
create policy job_update_own on job for update to authenticated
  using ((select auth.uid()) = owner)
  with check ((select auth.uid()) = owner);
create policy job_delete_own on job for delete to authenticated
  using ((select auth.uid()) = owner);

-- requirement (child: owner via job) ─────────────────────────────────────────
create policy requirement_select_own on requirement for select to authenticated
  using (exists (select 1 from job j
                 where j.id = requirement.job_id and j.owner = (select auth.uid())));
create policy requirement_insert_own on requirement for insert to authenticated
  with check (exists (select 1 from job j
                      where j.id = requirement.job_id and j.owner = (select auth.uid())));
create policy requirement_update_own on requirement for update to authenticated
  using (exists (select 1 from job j
                 where j.id = requirement.job_id and j.owner = (select auth.uid())))
  with check (exists (select 1 from job j
                      where j.id = requirement.job_id and j.owner = (select auth.uid())));
create policy requirement_delete_own on requirement for delete to authenticated
  using (exists (select 1 from job j
                 where j.id = requirement.job_id and j.owner = (select auth.uid())));

-- coverage (child: owner via job) ────────────────────────────────────────────
create policy coverage_select_own on coverage for select to authenticated
  using (exists (select 1 from job j
                 where j.id = coverage.job_id and j.owner = (select auth.uid())));
create policy coverage_insert_own on coverage for insert to authenticated
  with check (exists (select 1 from job j
                      where j.id = coverage.job_id and j.owner = (select auth.uid())));
create policy coverage_update_own on coverage for update to authenticated
  using (exists (select 1 from job j
                 where j.id = coverage.job_id and j.owner = (select auth.uid())))
  with check (exists (select 1 from job j
                      where j.id = coverage.job_id and j.owner = (select auth.uid())));
create policy coverage_delete_own on coverage for delete to authenticated
  using (exists (select 1 from job j
                 where j.id = coverage.job_id and j.owner = (select auth.uid())));

-- document (child: owner via job) ────────────────────────────────────────────
create policy document_select_own on document for select to authenticated
  using (exists (select 1 from job j
                 where j.id = document.job_id and j.owner = (select auth.uid())));
create policy document_insert_own on document for insert to authenticated
  with check (exists (select 1 from job j
                      where j.id = document.job_id and j.owner = (select auth.uid())));
create policy document_update_own on document for update to authenticated
  using (exists (select 1 from job j
                 where j.id = document.job_id and j.owner = (select auth.uid())))
  with check (exists (select 1 from job j
                      where j.id = document.job_id and j.owner = (select auth.uid())));
create policy document_delete_own on document for delete to authenticated
  using (exists (select 1 from job j
                 where j.id = document.job_id and j.owner = (select auth.uid())));

-- doc_line (child: owner via document -> job, two hops) ──────────────────────
create policy doc_line_select_own on doc_line for select to authenticated
  using (exists (select 1 from document d join job j on j.id = d.job_id
                 where d.id = doc_line.document_id and j.owner = (select auth.uid())));
create policy doc_line_insert_own on doc_line for insert to authenticated
  with check (exists (select 1 from document d join job j on j.id = d.job_id
                      where d.id = doc_line.document_id and j.owner = (select auth.uid())));
create policy doc_line_update_own on doc_line for update to authenticated
  using (exists (select 1 from document d join job j on j.id = d.job_id
                 where d.id = doc_line.document_id and j.owner = (select auth.uid())))
  with check (exists (select 1 from document d join job j on j.id = d.job_id
                      where d.id = doc_line.document_id and j.owner = (select auth.uid())));
create policy doc_line_delete_own on doc_line for delete to authenticated
  using (exists (select 1 from document d join job j on j.id = d.job_id
                 where d.id = doc_line.document_id and j.owner = (select auth.uid())));
