-- Veritas — candidate IDENTITY (profile).
--
-- A profile is DOCUMENT-AUTHOR metadata: the real person's name + contact, used ONLY in the PDF
-- letterhead/signature so a generated résumé/cover letter is addressable and sendable. It is
-- deliberately NOT a fact: it is never a résumé claim, never enters coverage matching, citation, or
-- generation, and is never part of the doc_line / connective provenance path. (Voice still comes from
-- writing_sample facts, unchanged.) So identity lives in its OWN table — never as a fact_type — with
-- the SAME deny-by-default per-user RLS ownership pattern that fact/job use.
--
-- ONE row per user: the PK IS user_id (a FK to auth.users). user_id is therefore BOTH the identity of
-- the row AND the ownership column the policies key on — i.e. the fact/job `owner` pattern with `owner`
-- collapsed onto the PK, because there is exactly one profile per user (the PK enforces it).
--
-- Fields are USER-OWNED and USER-ENTERED — never fabricated or derived (e.g. NEVER an email local-part).
-- full_name is required (NOT NULL, non-empty, mirroring fact.content's check); phone / location /
-- professional_url are optional. The email is NOT stored here: it comes from auth.users, so the
-- letterhead reads it from the session and identity has a single source that cannot drift.

create table profile (
  user_id          uuid primary key references auth.users (id) on delete cascade,
  full_name        text not null check (btrim(full_name) <> ''),
  phone            text,
  location         text,
  professional_url text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create trigger profile_set_updated_at
  before update on profile
  for each row execute function set_updated_at();

-- ── table privileges — strip the public API roles, grant DML to authenticated only ───────────────
-- Mirrors the fact/job pattern (20260614120000): anon's denial rests on TWO independent layers — no
-- table privilege (this REVOKE, which also strips Supabase's default-privilege auto-grant on new public
-- tables) AND no row policy (the RLS below). `authenticated` keeps access via its explicit grant;
-- `service_role` keeps its own Supabase grant (+ BYPASSRLS) and is untouched. NO delete grant: a profile
-- is created/edited in place (upsert), never deleted from the app; the row cascades when its auth user
-- is deleted. (PK is the uuid FK — no sequence grants.)
revoke all on profile from anon, public;
grant select, insert, update on profile to authenticated;

-- ── RLS: the authenticated role may touch ONLY its own profile row ────────────────────────────────
-- `(select auth.uid())` (sub-select form) lets the planner evaluate auth.uid() once per statement.
-- Per-command semantics mirror fact/job: INSERT WITH CHECK → cross-user is a hard 42501; UPDATE USING
-- filters non-owned rows to a silent no-op while WITH CHECK guards the new image (re-keying user_id to
-- another user is a hard 42501). There is intentionally NO delete policy → DELETE is deny-by-default.
alter table profile enable row level security;

create policy profile_select_own on profile for select to authenticated
  using ((select auth.uid()) = user_id);
create policy profile_insert_own on profile for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy profile_update_own on profile for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
