-- Veritas — enable row level security on already-applied environments.
--
-- The initial migration (20260613022240_init_veritas_schema.sql) now enables RLS
-- inline, so any DB created fresh from migrations is secure. But that initial
-- migration was already pushed/applied to the live Supabase project BEFORE the RLS
-- block was added to it. Editing an already-applied migration does not re-run it,
-- so the live database would remain without RLS. This follow-up migration applies
-- the same deny-by-default RLS to those existing environments.
--
-- Why this is safe to run everywhere: `enable row level security` is idempotent —
-- running it on a table that already has RLS enabled is a no-op, not an error. So
-- fresh DBs (already secured by the initial migration) and existing DBs (secured
-- here) both end up correct.
--
-- Deny-by-default, no permissive policies: with RLS on and zero policies, every row
-- is denied to the public `anon` / `authenticated` API roles. The app reaches the
-- database only through the server-side service-role client (src/lib/db/client.ts),
-- and `service_role` carries BYPASSRLS, so server-side access is unaffected. The
-- provenance triggers and CHECK constraints are untouched — RLS filters which rows a
-- role may touch; it does not disable triggers or constraints.
--
-- When real multi-user auth arrives, add explicit per-user policies then; do not
-- loosen this default to get the browser talking to the DB directly.
alter table fact        enable row level security;
alter table job         enable row level security;
alter table requirement enable row level security;
alter table coverage    enable row level security;
alter table document    enable row level security;
alter table doc_line    enable row level security;
