---
name: veritas-security-proof
description: Prove, by execution, the two M1 security properties — (A) RLS deny-by-default blocks the public anon role from READING any row (an unfiltered select returns 0 while the service role sees the rows) and from WRITING (insert/update/delete, each judged by service-role ground truth) on all six tables; and (B) the server-only guard makes `next build` fail ATTRIBUTABLY when src/lib/db/client.ts is imported from a Client Component (green without the probe, fails only with it). Run before any CRUD touches real career data, and on any change to src/lib/db, the RLS in supabase/migrations, or this script.
disable-model-invocation: true
argument-hint: "(no arguments; reads .env.local, runs next build)"
---

# Veritas security proof

Prove — by execution, never by inspection — the two things M1 asserted but only
confirmed manually, **before** M2 puts real career data in the database:

- **A. RLS deny-by-default.** Holding the publishable **anon key** and talking to
  PostgREST exactly as a browser would, on every one of the six tables (`fact, job,
  requirement, coverage, document, doc_line`) the `anon` role can:
  - **read no row** — an **unfiltered** anon select returns **0 rows** while the
    **service role** confirms ≥2 rows exist, so "anon got nothing" means "RLS hid
    every row", not "the table was empty" or "I hit the wrong database"; and
  - **write no row** — anon **INSERT**, **UPDATE**, and **DELETE** are each rejected,
    each judged by **service-role ground truth** (was a row actually created /
    changed / removed?), never by trusting anon's own — maskable — response.
- **B. The `server-only` build guard.** A Client Component importing the DB client
  (`src/lib/db/client.ts`, which carries the service-role key) makes `next build`
  **fail attributably** — the app builds green *without* the probe and fails *only
  with* it, the error naming `security-probe/page.tsx → src/lib/db/client.ts`. Proven
  by actually building, so the key can never reach the browser bundle.

## The one hard rule
The run MUST exit non-zero with **"COULD NOT VERIFY"** if it cannot prove a property —
a transport/connection failure, a 404, a service-role check that can't confirm the
seeded rows, an ambiguous (non-`42501`) write rejection, a build that can't run / a
non-green baseline / a failure not attributable to our probe, or fewer than the **25**
registered checks executing. An empty or partial result is a FAILURE, never a pass.
Report success only when all 25 checks ran and passed. The bundled script enforces
this; do not work around it.

## What it checks
| Property | Probe | Pass condition |
|---|---|---|
| A — read denial (×6) | anon UNFILTERED select; svc confirms ≥2 rows | anon returns 0 rows (or a `42501` grant error) |
| A — insert denial (×6) | anon INSERT of a well-formed row | `42501` (RLS); doc_line: `23503` provenance trigger, no row created |
| A — update denial (×6) | anon UPDATE of a seeded row | svc ground truth: the column is **unchanged** |
| A — delete denial (×6) | anon DELETE of a seeded row | svc ground truth: the row is **still present** |
| B — build guard (×1) | baseline `next build`, then again with a probe Client Component | baseline **green**; probe build **fails** naming `security-probe` → `client.ts` + the server-only boundary |

Any anon-visible row, a successful anon INSERT, a column the anon UPDATE changed, a row
the anon DELETE removed, or a green probe build = LEAK / broken guard = regression (exit 1).

## No secrets here
The bundled `verify-security.mjs` reads `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and
`SUPABASE_ANON_KEY` at run time from `<repo>/.env.local` (gitignored). The anon key is
the *public* publishable key, but it still lives only in `.env.local`, never in this
skill or any committed file. Before running, decode the keys' JWT `role` claim and
**refuse to run** if the anon var is actually the service key (the one misconfig that
would make this test lie).

## Run it
No throwaway install — `@supabase/supabase-js` and `next` are already project deps.
From the repo root:

```
node .claude/skills/veritas-security-proof/verify-security.mjs "$PWD"
```

It seeds 2 probe rows per table via the service role, runs the 24 anon checks
(read/insert/update/delete × 6), then builds once **without** a probe (must be green)
and once **with** a temporary `src/app/security-probe/page.tsx` (must fail attributably),
removing it after. Exit `0` = proved, `1` = regression (a leak or a broken guard — STOP,
do not merge), `2` = could not verify (fix the cause and re-run; never treat as a pass).

## How it refuses to lie
- **Reads are unfiltered**, judged against a service-role count: anon must return 0
  rows while svc sees ≥2 — so a policy hiding only one probed row, or an empty table,
  cannot pass. A `42501` grant error also counts as denial; **any other error —
  including a 401/403 auth failure — is COULD NOT VERIFY**, never a denial. The only
  read PASS is an authoritative `42501` or a true `200`-empty.
- **Writes are judged by service-role ground truth**, not anon's response: anon's
  `.update()/.delete()` RETURNING can be masked by RLS (anon may lack SELECT), so the
  proof re-reads each row AS the service role and PASSes only if it is genuinely
  unchanged / still present. A successful INSERT, a changed column, or a missing row is
  a LEAK.
- **doc_line INSERT** is refused before RLS by the fact-existence trigger (run AS anon,
  which can't see the cited fact): that `23503` is reported as a *provenance* denial (no
  row created), **not** as proof of doc_line's RLS write-denial — which is instead
  proven by its UPDATE and DELETE checks.
- `status === 0` (a transport throw) and any `404` (missing table or PostgREST's
  404→`[]` rewrite) are COULD NOT VERIFY, never a pass.
- **Part B** wipes `.next` before each build (Turbopack — the Next 16 default — caches
  aggressively), requires the **baseline (no probe) to build green**, and PASSes only
  on a probe-build failure whose output names our probe page AND `client.ts` AND the
  server-only boundary — so an unrelated server-only failure can't satisfy it. The probe
  imports **only** `getDb`, never `server-only` directly, so the build fails solely
  because `client.ts` carries the guard (remove the guard → the build goes green → this
  check FAILs).
- It leaves the database and working tree exactly as it found them: a marker-prefixed
  sweep removes the probe rows (and any leaked rows) on the way out, and on a
  prior-crash recovery on the way in; the probe dir is removed in `finally` and on
  SIGINT/SIGTERM, and is gitignored as a backstop.

## Deferred — the `authenticated` role
This proof covers the **anon** role, which is the live public attack surface: the
publishable key ships in browser bundles. The **`authenticated`** role has the
*identical* zero-policy denial, but v1 has no Auth/users, so exercising it would mean
introducing the JWT secret to sign a token for a code path that does not exist yet.
That check is **deferred until Supabase Auth actually lands**, at which point it is a
prerequisite of that auth work (add an authenticated-role read/write denial pass here,
and seed a second user's rows to prove cross-user isolation once policies exist). This
deferral is recorded here and in PROMPTS.md item ③ so it resurfaces at the right time.

## Do not
- Treat a connection/transport/404 failure, or a `2` exit, as anything but "not proven".
- Treat a non-`42501` write rejection (a CHECK/FK/`23xxx`, or an auth error) as proof of
  RLS denial — it is not; only `42501` (or doc_line's documented `23503`) counts.
- Pass the build guard on the `server-only` string alone — require a green baseline and a
  failure that names our probe page and `client.ts`.
- Add a permissive anon policy to "make it pass" — the whole point is that none exists.
- Skip this because "it passed before" — the change in front of you is unverified.
