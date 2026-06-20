---
name: veritas-invariant-smoke-test
description: A LOCAL MERGE GATE proving the Veritas provenance invariant is installed by the WORKING-TREE migration FILES. It runs `supabase db reset` itself (re-applying supabase/migrations/*.sql into the local stack) THEN confirms Postgres rejects the three forbidden ops — empty fact_ids (23514), citing a nonexistent fact (23503), deleting a cited fact (23503). Binds to the files, not the connected schema, so a reset-then-edited migration can't false-pass. After the reset it sources its connection from `supabase status` (the very stack the reset targeted — no separate env URL that could point at a different instance). Loopback-only. Run before committing any change under supabase/migrations or src/lib/provenance.
disable-model-invocation: true
argument-hint: "(no arguments; local stack up; runs db reset itself + sources its own creds from supabase status)"
---

# Veritas invariant smoke-test

Prove — by execution, never by inspection — that the core invariant still holds: a
`doc_line` must cite >=1 real fact, and a cited fact cannot vanish. Run on **every**
change that touches `supabase/migrations/**` or `src/lib/provenance/**`, before
committing it. A prior pass never counts for a later change — re-run.

**Freshness is owned, not trusted.** The proof runs `supabase db reset` **itself** — which
re-applies the current working-tree `supabase/migrations/*.sql` into the local stack — and
only THEN runs the invariant test. So it binds to the **files you are about to merge**, not
to whatever schema happens to be connected. Without this a stale-but-still-enforcing local
DB would pass while the edited migration you're merging no longer installs the invariant —
the concrete false-pass this gate exists to prevent.

**Local only.** It is loopback-gated and resets the **local** stack (the one `supabase
start` brings up); it refuses a non-loopback reset target and must never reset or test a
remote/hosted project. Deploy-time verification against hosted is a **separate, deferred**
concern — not this script.

**Same-stack binding.** "Freshness against the local stack" only means something if the test
runs against the stack the reset *reset*. So after `db reset` the proof sources its connection
(`API_URL` + `SERVICE_ROLE_KEY`) from `supabase status -o json`, run in the **same cwd** as the
reset — both resolve the stack from `supabase/config.toml`, so they are one and the same
instance. **No env URL is read**: there is no second target that could silently point at a
different (un-reset) local stack. It uses `@supabase/supabase-js` (already a project dep).

## The one hard rule
A forbidden op that is **not rejected** is a FAIL; a **wrong SQLSTATE** is a FAIL. The
cleanup is **verified**, not assumed — if any probe row or the throwaway user is left
behind, that is a distinct failure, not a pass. Report success only if all three violations
were rejected with the exact expected SQLSTATE **and** the DB was left clean. The bundled
script enforces this; do not work around it.

## What it checks
| # | Operation | Expected rejection |
|---|-----------|--------------------|
| 1 | insert doc_line with fact_ids '{}'   | 23514 doc_line_fact_ids_not_empty |
| 2 | insert doc_line citing a random UUID | 23503 assert_fact_ids_exist |
| 3 | delete a fact cited by a doc_line    | 23503 protect_cited_fact |

## Exit codes
| code | meaning |
|---|---|
| 0 | invariant installed by the fresh files (3 rejections) AND the DB left clean |
| 1 | REGRESSION — a violation was not rejected (a CHECK/trigger is missing/weakened) |
| 2 | COULD NOT VERIFY — `db reset` / `supabase status` / connect / seed failed, non-loopback target, or fewer than 3 tests ran |
| 3 | CLEANUP LEAK — the invariant held, but the proof did not leave the DB clean |

## No secrets here
The bundled `verify.mjs` sources `API_URL` and `SERVICE_ROLE_KEY` at run time from `supabase
status -o json` (the running local stack) — not from any committed or env file. On a local
stack these are the well-known demo keys; nothing credential-like is stored in this skill. It
refuses to run if the sourced service key decodes to `role=anon`.

## Run it
No throwaway install — `@supabase/supabase-js` is already a project dep, and the proof runs
`db reset` **and** sources its own creds (from `supabase status`) for you. Just bring up the
local stack (`supabase start`), then from the repo root:

```
node .claude/skills/veritas-invariant-smoke-test/verify.mjs "$PWD"
```

It runs `supabase db reset` (≈30–60s), then mints a throwaway Admin-API owner (`fact`/`job`
require one), seeds a marker-prefixed `job`/`document`/`fact`, runs the three forbidden ops,
and **sweeps + verifies** — deleting the throwaway user and confirming zero marker rows
remain. `db reset` wipes the DB first, so it also recovers from any crashed prior run. Seeds
as the **service role**, which is subject to the CHECK/triggers (`BYPASSRLS` skips RLS, never
constraints or triggers), so an RLS policy can never hide a rejection.

## How it refuses to lie
- **It binds to the files, not the schema.** Because it runs `db reset` itself, a CHECK or
  trigger removed from a migration file is *gone* from the freshly-applied schema, so the
  matching forbidden op SUCCEEDS → recorded **FAIL ("NONE (operation SUCCEEDED)")**.
  (Empirically re-verified: dropping `protect_cited_fact` from the migration makes the proof
  exit 1; reverting makes it exit 0.)
- **It binds to the stack it reset, not a stray URL.** The test connection is sourced from
  `supabase status` in the *same cwd* as the reset (same `config.toml` → same instance), so the
  test can't run against a different, un-reset local stack — the exact gap that "resets stack A,
  tests stack B, still exits 0" would open. (Empirically re-verified: a divergent `SUPABASE_URL`
  in `.env.test.local` is inert — the proof still binds to the reset stack and exits 0.)
- A SUCCESS where a rejection was due is always a FAIL; a wrong SQLSTATE (e.g. a `23502`
  NOT NULL masking the expected `23514` CHECK) is a FAIL.
- A `db reset` failure, a missing/`role=anon` key, a non-loopback URL, or any connect/seed
  failure → COULD NOT VERIFY (exit 2). An empty or partial result is a FAILURE, never a pass.
- **Cleanup is verified.** After the tests it re-counts marker rows and re-checks the
  throwaway user; a non-empty result or a sweep/delete error → CLEANUP LEAK (exit 3), with
  exactly what was left printed. (Empirically re-verified: forcing the sweep to skip makes
  the proof exit 3 and report `left jobs/facts` + the throwaway user.) "Fully swept on every
  exit path" actually holds.

## Do not
- Manually `db reset` first and assume that's the gate — the proof owns that step on purpose;
  a separate reset is just convenience, the proof re-does it.
- Point it at a non-loopback / hosted project — it refuses (this is the local merge gate).
- Treat a `db reset`/connect/seed failure, a `role=anon` key, or a `2`/`3` exit as anything
  but "not proven / not clean".
- Seed as a role that bypasses CHECK constraints/triggers — the service role is correct (it
  skips RLS, not triggers).
- Skip this because "it passed before" — the change in front of you is unverified.
