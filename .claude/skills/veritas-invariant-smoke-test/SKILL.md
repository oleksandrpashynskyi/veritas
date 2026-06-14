---
name: veritas-invariant-smoke-test
description: Prove the Veritas provenance invariant by execution. Applies every working-tree migration into a throwaway DB schema, then confirms Postgres rejects the three forbidden operations. Run before committing any change under supabase/migrations or src/lib/provenance.
disable-model-invocation: true
argument-hint: "(no arguments)"
---

# Veritas invariant smoke-test

Prove — by execution, never by inspection — that the core invariant still holds: a
`doc_line` must cite >=1 real fact, and a cited fact cannot vanish. Run on **every**
change that touches `supabase/migrations/**` or `src/lib/provenance/**`, before
committing it. A prior pass never counts for a later change — re-run.

## The one hard rule
The run MUST exit non-zero with "COULD NOT VERIFY" if it cannot connect, a migration
fails to apply, or **fewer than three tests actually execute**. An empty or partial
result set is a FAILURE, never a pass. Report success only if all three violations
were attempted and all three were rejected with the expected SQLSTATE. The bundled
script enforces this; do not work around it.

## What it checks
| # | Operation | Expected rejection |
|---|-----------|--------------------|
| 1 | insert doc_line with fact_ids '{}'   | 23514 doc_line_fact_ids_not_empty |
| 2 | insert doc_line citing a random UUID | 23503 assert_fact_ids_exist |
| 3 | delete a fact cited by a doc_line    | 23503 protect_cited_fact |

## No secrets here
The bundled `verify.mjs` reads the DB password at run time from `<repo>/.env.local`
(the var whose name contains PASSWORD and not SERVICE) and derives the project ref
from `SUPABASE_URL` there. Nothing credential-like is stored in this skill. Pooler
host/region are non-secret (see the `supabase-connection` memory) and overridable via
`VERITAS_POOLER_HOST`.

## Run it
The skill bundles the proven script `verify.mjs` (the can't-false-pass guard is locked
into it). To run:
1. Make a throwaway dir OUTSIDE the repo so package.json/lock stay clean:
   `npm init -y` there, then `npm install pg@<version >=14 days old>` (AGENTS.md).
2. Copy `${CLAUDE_SKILL_DIR}/verify.mjs` into that dir (so `import "pg"` resolves).
3. From the repo root: `node <throwaway>/verify.mjs "$PWD"`.
4. Remove the throwaway dir when done.

It applies **every** `*.sql` in `supabase/migrations/` in filename order into a fresh
`veritas_test` schema, runs the three tests as the table owner (subject to the
CHECK/triggers, not blocked by RLS), then drops the schema — the real `public` schema
and migration history are left untouched.

## TLS — surfaced, never silently disabled
`verify.mjs` verifies the certificate by default. The Supabase pooler uses a
self-signed cert, so pick explicitly:
- `VERITAS_CA_CERT=<path to Supabase CA>` → verify-full (strongest), or
- `VERITAS_TLS_INSECURE=1` → encrypted-but-unverified (sslmode=require, what the
  supabase CLI itself uses).
With neither set it refuses to connect rather than silently skipping verification.

## Do not
- Apply only the base migration — the script applies the whole sequence; keep it so.
- Connect as a role that bypasses CHECK constraints/triggers.
- Treat a connection/auth failure as anything but COULD NOT VERIFY.
- Skip this because "it passed before" — the change in front of you is unverified.
