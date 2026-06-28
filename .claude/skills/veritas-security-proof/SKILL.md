---
name: veritas-security-proof
description: Prove, by execution against a LOCAL Supabase stack — which it first resets to the working-tree migrations (so the proof binds to the files about to merge, not a stale connected schema) and then connects to via supabase status — three security properties — (A) RLS deny-by-default blocks the public anon role from READING any row (an unfiltered select returns 0 while the service role sees the rows) and from WRITING (insert/update/delete on a representative seeded row of each table, judged solely by service-role ground truth) on all six tables; (C) per-user ownership isolation for the authenticated role — two real users A and B cannot read or write each other's rows (read by specific-id presence/absence; cross-user writes judged by service-role ground truth, with positive controls) across the six FK-owned tables and the profile identity table, the Auth Foundation milestone (M1.5); and (B) the server-only guard makes `next build` fail ATTRIBUTABLY when the db client (@/lib/db/client) is imported directly from a Client Component. The proof creates and deletes auth users, so it runs only against a loopback (local) URL. Run before any CRUD touches real career data, and on any change to src/lib/db, the RLS in supabase/migrations, or this script.
disable-model-invocation: true
argument-hint: "(no arguments; loopback/local stack only; runs db reset + sources creds from supabase status; creates/deletes test users; runs next build)"
---

# Veritas security proof

Prove — by execution, never by inspection — three security properties, against a
**local throwaway Supabase stack** (it creates and deletes auth users), **before** M2
puts real career data in the database:

- **A. RLS deny-by-default (the `anon` role).** Holding the publishable **anon key** and
  talking to PostgREST exactly as a browser would, on every one of the six tables (`fact,
  job, requirement, coverage, document, doc_line`) the `anon` role can:
  - **read no row** — an **unfiltered** anon select returns **0 rows** while the
    **service role** confirms ≥2 rows exist, so "anon got nothing" means "RLS hid
    every row", not "the table was empty" or "I hit the wrong database"; and
  - **write no row** — anon **INSERT**, **UPDATE**, and **DELETE** on a **representative
    seeded row** of each table are denied, judged SOLELY by **service-role ground truth**
    (did a row actually appear / change / disappear?), never by trusting anon's own —
    maskable — response. A PASS additionally requires the write to have reached Postgres
    (a clean 2xx no-op, or a SQLSTATE rejection like `42501`), so an auth/gateway/transport
    error is COULD NOT VERIFY, not "denied". (Exhaustive per-payload-shape write coverage
    is deferred hardening.)
- **C. Per-user ownership isolation (the `authenticated` role) — Auth Foundation / M1.5.**
  Two real users **A** and **B** are created via the Admin API and their data seeded with
  true owners. Then, by real behaviour judged by **service-role ground truth**, run in
  **BOTH directions** (A-attacks-B AND B-attacks-A) for every table and every operation —
  so an asymmetric policy bug (e.g. a leaked/hardcoded uid letting one user reach the
  other but not vice-versa) cannot stay green:
  - **read isolation** — each user's unfiltered select contains **all of its own** seeded
    rows and **specifically none** of the other user's seeded rows (asserted by exact id),
    so an empty/partial result can never be mistaken for denial; and
  - **write isolation** — INSERT-ing a row owned by the other user, or re-owning your own
    row to them, is a hard **42501**; UPDATE/DELETE of the other user's row is a **silent
    RLS no-op** (0 rows, no error) that leaves that row unchanged/present. **Positive
    controls** (the owner acting on its OWN rows succeeds) run alongside every deny check,
    so a blanket failure cannot masquerade as isolation.
  All six FK-owned tables get this treatment in both directions — proven directly, not inferred from one another: the
  owned roots `fact`/`job`, the one-hop children `requirement`/`coverage`/`document` (owner
  inherited via `job`), and the two-hop `doc_line` (via `document → job`). For a child,
  "give-away" means re-parenting it to a job owned by the other user, which the UPDATE
  `WITH CHECK` rejects with `42501`. The **`profile`** identity table (candidate name + contact for the
  PDF letterhead — author metadata, NOT a fact; PK = `user_id`, one row per user) is also covered in both
  directions, with a tailored **6-op** battery (read-iso, ins-as-other, ins-own, give-away, upd-other,
  upd-own): its policy set is select/insert/update only, so `del-*` is omitted (no delete policy by
  design), and "give-away" is re-keying `user_id` to the other user, rejected `42501` by `WITH CHECK`.
- **B. The `server-only` build guard.** A Client Component importing the db client
  **directly** (`@/lib/db/client`, which carries the service-role key) makes `next build`
  **fail attributably** — the app builds green *without* the probe and fails *only with*
  it, the error naming `security-probe/page.tsx → client.ts` **specifically** (so the
  guard cannot escape detection by being relocated off `client.ts`). Proven by actually
  building, so the key can never reach the browser bundle.

## Freshness is owned, and the target is bound
Like the invariant smoke-test, this proof **runs `supabase db reset` itself** immediately
before the isolation battery — re-applying the working-tree `supabase/migrations/*.sql`
(including the RLS/ownership migration) into the local stack — then sources its connection
(`API_URL` + `ANON_KEY` + `SERVICE_ROLE_KEY`) from **`supabase status -o json`** run in the
**same cwd**. So it proves the **working-tree RLS migration applied fresh** isolates — not
whatever schema happened to be connected — and the stack it tests is provably the stack the
reset reset (same cwd → same `supabase/config.toml` → same instance). **No env URL/key is
read**, so a divergent `.env` value cannot redirect it at a different (un-reset) stack. A
`db reset` / `supabase status` failure → COULD NOT VERIFY.

**Auth-readiness gate (post-reset).** `db reset` restarts the auth container, and the Kong
gateway can briefly hold a stale route to it (transient **502**) even though GoTrue is
healthy. So before minting any user the proof polls the gateway's `/auth/v1/health` until
**200** (bounded ~30s); on timeout it bails to **COULD NOT VERIFY** with a `docker restart
supabase_kong_resume` hint — it never runs the battery against a not-ready stack, and it
**fails closed**. This gates only *whether* the battery runs, never how it judges.

## The one hard rule
The run MUST exit non-zero with **"COULD NOT VERIFY"** if it cannot prove a property —
a failed `supabase db reset` or `supabase status`, a non-loopback reset target, a
transport/connection failure, a 404, a service-role
check that can't confirm the seeded rows or the post-write DB state, an anon write that
never reached RLS (auth/gateway/transport), a positive control that fails (the owner
couldn't touch its own row), a build that can't run / a non-green baseline / a failure
not attributable to our probe, or fewer than the **133** registered checks executing. An
empty or partial result is a FAILURE, never a pass. And even when all 133 pass, if the
teardown can't be confirmed clean (sweep/delete errored, or marker rows / A-B users remain)
the run exits **3 (cleanup leak)**, not 0. Report success only when all 133 checks ran and
passed **and** the stack was left clean. The bundled script enforces this; do not work around it.

## What it checks
| Property | Probe | Pass condition |
|---|---|---|
| A — read denial (×6) | anon UNFILTERED select; svc confirms ≥2 rows | anon returns 0 rows (or a `42501` grant error) |
| A — insert denial (×6) | anon INSERT a row, then svc re-count | svc ground truth: **no new row** — and the write reached Postgres |
| A — update denial (×6) | anon UPDATE a seeded row, then svc re-read | svc ground truth: the column is **unchanged** |
| A — delete denial (×6) | anon DELETE a seeded row, then svc re-check | svc ground truth: the row is **still present** |
| C — read isolation (×14) | each user, **both directions**, all six FK-owned tables + `profile`: UNFILTERED select; assert own ids present, other's ids absent | sees all own seeded rows, **none** of the victim's specific rows |
| C — write isolation (×94) | **both directions**, all six FK-owned tables (7 write ops) + `profile` (5 write ops — no delete policy): attacker INSERT-as-victim / give-away (re-own a root, re-parent a child, or re-key a profile's `user_id` to the victim) / UPDATE/DELETE the victim's row, plus owner-on-own positive controls | cross-owner INSERT & give-away → `42501` + DB unchanged; cross-user UPDATE/DELETE → **zero-row SUCCESS** (an error is CNV) + victim's row unchanged/present; the owner's own ops **succeed** |
| B — build guard (×1) | baseline `next build`, then again with a probe importing `@/lib/db/client` | baseline **green**; probe build **fails** naming `security-probe` → `client.ts` + the server-only boundary |

A returned row, a new row after an anon INSERT, a column the anon UPDATE changed, a row
the anon DELETE removed, **a user seeing or altering another user's row**, or a green
probe build = LEAK / broken guard = regression (exit 1).

The migration **revokes all** privileges from `anon` and the `public` pseudo-role and
grants DML to `authenticated` **only**, so anon's denial rests on **no-grant AND
no-policy** (the anon reads now surface `42501 permission denied for table`). The
anon-denial checks, the authenticated positive controls, and the service-role seeding
together are the regression that proves the revoke denied `anon` and broke neither the
`authenticated` nor the `service_role` path.

## No secrets here
The bundled `verify-security.mjs` sources `API_URL`, `SERVICE_ROLE_KEY` and `ANON_KEY` at
run time from **`supabase status -o json`** (the running local stack) — not from any env or
committed file. On a local stack these are the well-known demo keys; nothing credential-like
is stored in this skill. Before running, it decodes the sourced keys' JWT `role` claim and
**refuses to run** if the anon key is actually the service key (or vice-versa), and **refuses
to run** unless the reset target's `API_URL` is loopback (`127.0.0.1`/`localhost`) — the proof
resets the DB and creates/deletes auth users, so it must never touch a remote/production project.

## Run it
No throwaway install — `@supabase/supabase-js` and `next` are already project deps, and the
proof runs `db reset` and sources its own creds (from `supabase status`) for you. Just bring
up the local stack (`supabase start`), then from the repo root:

```
node .claude/skills/veritas-security-proof/verify-security.mjs "$PWD"
```

It **resets the local DB** to the working-tree migrations (≈30–60s), refuses unless the
reset target is loopback, creates two test users (A, B) via the Admin API, seeds
owner-stamped probe rows via the service role, runs the **24 anon** checks
(read/insert/update/delete × 6) and the **108 authenticated-isolation** checks (users A vs
B, **both directions**, read + write, all six FK-owned tables + the `profile` identity table — each
battery self-seeds), then builds
once **without** a probe (must be green) and once **with** a temporary
`src/app/security-probe/page.tsx` (must fail attributably), removing the probe and deleting
the test users after. Exit `0` = proved (all 133 checks) and the stack left clean, `1` =
regression (a leak or a broken guard — STOP, do not merge), `2` = could not verify (fix the
cause and re-run; never treat as a pass), `3` = cleanup leak (every check passed but probe
rows / A-B users were left behind — distinct from the security result).

## How it refuses to lie
- **Reads are unfiltered**, judged against a service-role count: anon must return 0
  rows while svc sees ≥2 — so a policy hiding only one probed row, or an empty table,
  cannot pass. A `42501` grant error also counts as denial; **any other error —
  including a 401/403 auth failure — is COULD NOT VERIFY**, never a denial. The only
  read PASS is an authoritative `42501` or a true `200`-empty.
- **Writes are judged by service-role ground truth**, never anon's response (anon's
  own `.update()/.delete()` RETURNING can be masked by RLS, so it is never trusted).
  After the anon INSERT/UPDATE/DELETE the proof re-reads the DB AS the service role: a
  changed DB (a new row / changed column / missing row) is a LEAK (FAIL) regardless of
  what anon's call claimed. A PASS requires the state genuinely unchanged AND the write
  to have reached Postgres — a clean 2xx no-op (the deny-by-default outcome for
  update/delete) or a SQLSTATE rejection (`42501` for insert; `23xxx` for a
  constraint/trigger). An auth/gateway/transport error (status 0, or a non-SQLSTATE code
  like `PGRST301`) leaves the DB unchanged for the WRONG reason → COULD NOT VERIFY,
  never "denied". The anon **INSERT** is judged more strictly still: its payload carries a
  VALID owner (a real `auth.users` id) so a NOT NULL / FK constraint can't be what blocks
  it — only authorization — and a PASS requires the specific **`42501`** permission-denied
  (a constraint or any other SQLSTATE that leaves the DB unchanged → CNV, never a pass).
- **Part C (per-user isolation) is judged the same way — by service-role ground truth,
  never the user's own response — in BOTH directions, with extra defences.** It runs the
  full battery as A-attacks-B AND B-attacks-A on every table, so an asymmetric policy bug
  cannot stay green. READ isolation asserts the signed-in user sees its own seeded rows
  **by specific id** AND **none** of the victim's **specific** ids, so an empty/partial
  read is COULD NOT VERIFY, never a denial. CROSS-USER UPDATE/DELETE are a **silent RLS
  no-op** (RLS `USING` filters the row out → 0 rows), so a PASS requires a **zero-row
  SUCCESS** (`200 []` or `204`) AND the victim's row unchanged/present — an **ERROR** on
  these is CNV (it never exercised the no-op), and the `dbProcessed` reached-Postgres
  proxy is *not* used here (it is reserved for the anon checks). INSERT-as-victim and
  give-away (re-own/re-parent to the victim) ARE hard errors (`42501`, the `WITH CHECK`
  violation), required specifically. **Positive controls** —
  the owner inserting/updating/deleting its OWN rows — run beside every deny check, so a
  blanket breakage (the owner can't touch anything) surfaces as CNV instead of a false
  "isolated". The two test users sign in for real (anon key + password); the proof decodes
  each access token and refuses unless `role=authenticated` and `sub` is the expected user.
- `status === 0` (a transport throw) and any `404` (missing table or PostgREST's
  404→`[]` rewrite) are COULD NOT VERIFY, never a pass.
- **Part B** wipes `.next` before each build (Turbopack — the Next 16 default — caches
  aggressively), requires the **baseline (no probe) to build green**, and PASSes only on
  a probe-build failure whose output names our probe page AND `client.ts` AND the
  server-only boundary — so an unrelated server-only failure, or the guard being
  relocated off `client.ts`, can't satisfy it. The probe imports `getDb` from
  `@/lib/db/client` **directly** (not the barrel `@/lib/db`) and never `server-only`
  itself, so the build fails solely because `client.ts` carries the guard (remove the
  guard → the build goes green → this check FAILs).
- It owns the database state via the up-front `db reset` (which wipes the local DB and
  re-applies the working-tree migrations — fine for a disposable local stack, and it also
  recovers any crashed prior run), and leaves the auth users and the working tree clean: a
  marker-prefixed sweep removes the probe rows (and any leaked rows), the two test users are
  deleted (cascading their owned rows), both on the way out (`finally`) and on a prior-crash
  recovery on the way in; the probe dir is removed in `finally` and on SIGINT/SIGTERM, and is
  gitignored as a backstop. **The teardown is verified, not assumed**: the sweep/delete now
  surface their Supabase `{ error }`s, and a post-sweep re-count of marker rows + A/B users
  must come back empty — if a check otherwise passed but cleanup failed or left anything
  behind, that is a **CLEANUP LEAK (exit 3)**, not a pass (mirrors verify.mjs).

## Known limitation (deferred hardening) — postgrest-js 404 normalization
Anon write-denial rests on service-role ground truth **plus** a "did the write reach
Postgres?" check (`dbProcessed`). That check uses "no error" as a proxy, which is not
perfect: postgrest-js `PostgrestBuilder.processResponse` normalizes some 404s into
error-free responses — a 404 whose body is a JSON **array** becomes `{data:[],
error:null, status:200}`, and a 404 with an **empty** body becomes `status:204`. The
proof tightens for the 204 / residual-404 case (treated as COULD NOT VERIFY), but the
**array-body → `200 []`** case is indistinguishable from a genuine RLS-filtered `200 []`
and is left as **deferred hardening**. In practice it cannot mask a real leak: a 404
write body is an error object (not an array), and the same-table service-role
ground-truth reads would themselves CNV if the table were truly missing — but a
dedicated pass should make "reached Postgres" explicit (e.g. assert on a returned
representation / row count) rather than inferring it from the absence of an error.
(Note: this proxy is used for the anon writes; Part C's cross-user UPDATE/DELETE
deliberately do NOT use it — see "How it refuses to lie".)

## Done — the `authenticated` role (Auth Foundation / M1.5)
The authenticated-role pass is now **implemented and passing**: per-user ownership
(`owner` on the `fact`/`job` roots, inherited via RLS `EXISTS` for the four descendants)
plus the Part C checks above prove two real users are isolated for both read and write.
This supersedes the earlier "deferred until Supabase Auth lands" note.

### Still deferred
- **D-1 — same-owner citation.** "A resume line may cite only a fact with the same owner"
  is *designed-for* but not yet enforced or tested. Today's writes go through the
  service-role client (BYPASSRLS), so the `assert_fact_ids_exist()` trigger sees all
  facts. Once fact/doc_line CRUD runs as an **authenticated** user, that **SECURITY
  INVOKER** trigger's `select … from fact` is RLS-filtered to the caller's own facts and
  the rule holds for free (citing another user's fact fails `23503`). Add a Part C check
  proving it then. **Never** convert that trigger to `SECURITY DEFINER` without redoing
  this analysis — it would silently disable the filtering.
- **D-2 — app per-user data path.** The app still reaches Postgres via the service-role
  client; a per-user authenticated client (cookies/SSR) + login UI are deferred.
- **postgrest-js array-body → `200 []`** hardening (above) — unchanged.

## Do not
- Treat a connection/transport/404 failure, a non-loopback URL, or a `2` exit, as
  anything but "not proven".
- Trust anon's (or a user's) own response for a write verdict, or treat a DB-unchanged
  result as "denied" without confirming the write reached RLS — an auth/gateway/transport
  failure that no-ops the write is COULD NOT VERIFY, never a pass.
- Judge a cross-user UPDATE/DELETE by expecting an exception — it is a silent RLS no-op;
  judge it only by the target row being unchanged/present (svc ground truth).
- Pass the build guard on the `server-only` string alone, or import the db client via the
  barrel — require a green baseline, a failure naming our probe page AND `client.ts`, and
  a probe that imports `@/lib/db/client` directly.
- Add a permissive anon policy, or scope an ownership policy to `public`/anon instead of
  `to authenticated`, to "make it pass" — anon must keep zero applicable policies.
- Point this at a non-local project — it resets the DB and creates/deletes auth users, so it
  refuses a non-loopback reset target.
- Skip this because "it passed before" — the change in front of you is unverified.
