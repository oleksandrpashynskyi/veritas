---
name: veritas-security-proof
description: Prove, by execution, the two M1 security properties — (A) RLS deny-by-default blocks the public anon role from reading or writing any row of all six tables, proven via the anon KEY over PostgREST against a sentinel the service role can see; and (B) the server-only guard makes `next build` fail when src/lib/db/client.ts is imported from a Client Component. Run before any CRUD touches real career data, and on any change to src/lib/db, the RLS in supabase/migrations, or this script.
disable-model-invocation: true
argument-hint: "(no arguments; reads .env.local, runs next build)"
---

# Veritas security proof

Prove — by execution, never by inspection — the two things M1 asserted but only
confirmed manually, **before** M2 puts real career data in the database:

- **A. RLS deny-by-default.** Holding the publishable **anon key** and talking to
  PostgREST exactly as a browser would, the `anon` role can read **zero** rows and
  write **zero** rows on every one of the six tables (`fact, job, requirement,
  coverage, document, doc_line`). Proven against a sentinel row the **service-role**
  client provably *can* read — so "anon got nothing" means "RLS hid it", not "the
  table was empty" or "I hit the wrong database".
- **B. The `server-only` build guard.** A Client Component importing the DB client
  (`src/lib/db/client.ts`, which carries the service-role key) makes `next build`
  **fail** — proven by actually building, so the key can never reach the browser
  bundle.

## The one hard rule
The run MUST exit non-zero with **"COULD NOT VERIFY"** if it cannot prove a property —
a transport/connection failure, a 404, a service-role positive control that can't see
its own sentinel, an ambiguous (non-RLS) write rejection, a build that can't run or
fails for an unrelated reason, or fewer than the **13** registered checks executing.
An empty or partial result is a FAILURE, never a pass. Report success only when all 13
checks ran and passed. The bundled script enforces this; do not work around it.

## What it checks
| Property | Per table (×6) | Pass condition |
|---|---|---|
| A — read denial | anon SELECT of the sentinel row | HTTP 200 `[]` (RLS-filtered) **or** a 4xx permission error |
| A — write denial | anon INSERT of a well-formed row | rejected with SQLSTATE `42501` (RLS / no grant) |
| B — build guard | one `next build` with a probe Client Component | build exits non-zero **and** output names `server-only` + "cannot be imported from a Client Component module" |

A returned sentinel row = LEAK = regression (exit 1). A successful anon INSERT = LEAK =
regression (exit 1). A green build = the guard is broken = regression (exit 1).

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

It seeds a sentinel graph via the service role, runs the 12 anon checks, then writes a
temporary `src/app/security-probe/page.tsx`, runs `next build`, and removes it.
Exit `0` = proved, `1` = regression (a leak or a broken guard — STOP, do not merge),
`2` = could not verify (fix the cause and re-run; never treat as a pass).

## How it refuses to lie
- Anon reads are filtered to a sentinel the service role just proved exists, so an
  empty result is provably "hidden", not "absent".
- `status === 0` (a transport throw) and any `404` (missing table or PostgREST's
  404→`[]` rewrite) are COULD NOT VERIFY, never a pass.
- Anon write probes are well-formed (child rows cite the sentinel fact) so RLS is the
  only thing left to reject them; a `23xxx` CHECK/FK/trigger rejection is treated as
  inconclusive, not as proof of RLS.
- Part B wipes `.next` before and after (Turbopack — the default builder in Next 16 —
  caches aggressively) and only passes on a build failure it can attribute to the
  `server-only` boundary. The probe imports **only** `getDb`, never `server-only`
  directly, so the build fails solely because `client.ts` carries the guard.
- It leaves the database and working tree exactly as it found them: a marker-prefixed
  sweep removes the sentinel graph (and any leaked probe rows) on the way out, and on a
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
- Weaken a write probe so it trips a CHECK instead of RLS — that proves nothing about RLS.
- Match a bundler-specific build-error string; match the boundary phrase + `server-only`.
- Add a permissive anon policy to "make it pass" — the whole point is that none exists.
- Skip this because "it passed before" — the change in front of you is unverified.
