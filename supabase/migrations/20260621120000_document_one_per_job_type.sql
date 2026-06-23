-- M5 (Codex FIX 2) — at most ONE document per (job, type), enforced atomically.
--
-- M5 generation stores at most one résumé per job. persistResume pre-checks for an existing résumé,
-- but a pre-check-then-insert is RACEABLE: two concurrent saves can both pass the check and both
-- insert, leaving two résumés. This UNIQUE constraint makes the rule an atomic DB guarantee — the
-- losing insert fails with SQLSTATE 23505, which persistResume maps to the same "a résumé already
-- exists for this job" guard error (the pre-check stays as the friendly path). It also gives the
-- one-per-job rule to cover_letter for free when M6 lands.
--
-- Uniqueness only — no RLS policy or provenance trigger/CHECK is touched; the doc_line invariant and
-- the assert_fact_ids_exist / protect_cited_fact triggers are unaffected. `document` is empty on a
-- fresh `supabase db reset`, so the constraint applies with no backfill.
alter table document
  add constraint document_one_per_job_type unique (job_id, type);
