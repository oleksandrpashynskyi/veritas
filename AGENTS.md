AGENTS.md — Veritas (Truthful Resume Tailor)
Vision (read this first)
This app produces tailored resumes and cover letters in which every line is provably sourced from the user's verified master profile. The product is trust. A fabricated or uncited claim is not a bug — it is the failure of the entire product. When in doubt, refuse to generate rather than invent.

What you (the agent) must know that isn't obvious from the code
The core invariant: doc_line.fact_ids must be non-empty and reference real facts. The validation layer (src/lib/provenance/) enforces this. Never weaken, bypass, or "temporarily disable" it.
No ATS scores. Do not add scoring features even if they seem helpful. We show requirement coverage (met/partial/unmet) with evidence only.
Banned-words list lives in src/lib/provenance/banned.ts ("spearheaded", "leveraged", "synergize", etc.). Generation output containing them fails validation.
The banned-words list must never reject a truthful, sourced line. Ambiguous words (those with legitimate technical meaning, e.g. 'dynamic') should warn, not hard-block — refusing to forbid the truth takes priority over catching every cliché.
Voice: generation is conditioned on the user's writing samples (facts of type writing_sample). Output should sound like the user, not like a press release.
LLM calls use Anthropic structured outputs; every generation step must return fact citations alongside text.
Source code reference (use this instead of docs)
To understand a package or framework, read its actual source under repos/ (populated via opensrc). To fetch source for a new package: npx opensrc <package-or-repo>. Prefer reading code in repos/ over web search or memory of documentation.

Project structure
src/app/ — Next.js App Router pages and route handlers
src/lib/db/ — Supabase client + queries (all data access goes through here)
src/lib/provenance/ — validation layer: citation enforcement, banned words. The heart. Touch with reverence.
src/lib/llm/ — Anthropic API calls, structured extraction & generation
src/components/ — UI (shadcn/ui based)
supabase/migrations/ — schema
repos/ — downloaded library source (read-only reference; never edit)
Working rules
Small PRs. One milestone per session. If a plan grows beyond ~1 session of work, stop and split it.
Plan before code; present the plan and wait for approval.
Reuse existing functions; before writing a new helper, search src/lib/ for an existing one.
After completing a feature, identify duplicated code you created and consolidate it.
Write tests for the provenance layer for every change that touches it.
Never install a package published less than 14 days ago.
Never log or commit the user's personal career data or API keys.

Local dev — Supabase stack gotcha
`supabase db reset` restarts the auth (GoTrue) container, and the Kong gateway can hold a stale upstream route to it → transient HTTP 502 on auth calls (createUser / sign-in) right after a reset, worst on back-to-back resets. GoTrue itself stays healthy; the wedge clears with `docker restart supabase_kong_resume`. Any reset-then-auth flow must poll `GET {API_URL}/auth/v1/health` until 200 before minting users — the veritas-security-proof harness (verify-security.mjs) does this; the veritas-invariant-smoke-test (verify.mjs) adoption is deferred (low priority, low exposure).

Local dev — re-seeding after a stack reset
A stack reset / CLI bump / restart wipes the LOCAL database (all rows + auth users); the schema stays intact (it is rebuilt from `supabase/migrations/`). Re-populate a realistic test dataset with ONE command: `node seed.mjs` (stack must be up — `npx supabase start`). It is idempotent (safe to re-run — it clears then recreates only the test account's data) and sources LOCAL credentials from `supabase status` — NEVER from `.env` (whose non-prefixed `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` point at a HOSTED project) and never hardcoded; it refuses any non-loopback target. It creates a clearly-test login — `dev@veritas.test` / `veritas-dev-2026` (local throwaway, pre-confirmed so it signs in immediately) — and seeds that user's master profile (6 verified facts incl. 1 writing_sample for voice) + one job ("Senior Backend Engineer") with 5 requirements: enough to drive coverage → résumé → cover letter → PDF export. It touches ONLY the test account; any real account (e.g. your own email) is left untouched. After it runs: `npm run dev`, sign in at `/login` with the test login, then visit `/facts` and `/jobs`. (This is separate from `supabase/seed.sql`, which `supabase db reset` runs automatically but cannot create a password-signable auth user — that's why the seed is a JS script using the Admin API, mirroring the verify-*.mjs proofs.)