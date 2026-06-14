PROMPTS.md — Employee Briefings
How to use: one milestone per Claude Code session. Paste the prompt, review the plan it produces, trim it, approve, test, then run the closing ritual. Start a NEW session for the next milestone.

Session 0 — Environment (run these yourself in Cursor's terminal)
mkdir veritas && cd veritas && git init
npx create-next-app@latest . --typescript --tailwind --app
npx opensrc vercel/next.js
npx opensrc supabase/supabase-js
Copy AGENTS.md into the project root. Open the Claude Code panel.

M1 — Scaffold
Read AGENTS.md and PROJECT_PLAN.md fully before doing anything. Then produce a plan (no code yet) for Milestone 1: wire Supabase locally, create the initial migration implementing the data model in PROJECT_PLAN.md section 4, and stub the folder structure described in AGENTS.md (including an empty provenance module with its banned-words list). Keep the plan small enough to complete in this session. Wait for my approval before writing code.

M2 — Master Profile
Read AGENTS.md. Plan Milestone 2: CRUD UI and queries for fact records — list, create, edit, delete — grouped by type (experience, achievement, skill, education, writing_sample). Plain, fast UI with shadcn components. No LLM calls in this milestone. Plan first; wait for approval.
Prerequisite — DONE at M1 close (skill: veritas-security-proof). A security test now proves, by execution, that deny-by-default RLS denies the public anon role every row (an unfiltered anon read returns 0 while the service role sees the rows) AND denies anon writes to a representative seeded row of each table — insert, update, and delete, judged solely by service-role ground truth (did a row appear/change/disappear?) — on all six tables (exhaustive per-payload-shape write coverage is deferred hardening), and that importing the db client (@/lib/db/client) directly from a Client Component fails `next build` attributably (green without the probe, failing only with it, naming client.ts). M1 had asserted both but only confirmed them manually. Deferred hardening (known, non-blocking): write-denial via service-role ground truth has one known edge — postgrest-js 404 normalization can turn a never-reached write into an error-free `200 []`, which is indistinguishable from a genuine RLS-filtered empty result and could mask it as denied; the proof guards the 204/residual-404 form and documents the array-body→200 form, to be hardened in a dedicated pass (make "reached Postgres" explicit rather than inferred from no-error). Deferred: the authenticated role shares the identical zero-policy denial but has no code path in v1 (no Auth/users); its read/write-denial check is a prerequisite of the milestone that introduces Supabase Auth — extend veritas-security-proof then, adding cross-user isolation once per-user policies exist.

M3 — Job Ingest
Read AGENTS.md. Plan Milestone 3: a page where I paste a raw job description; a server action calls the Anthropic API with structured output to extract requirements (must / nice / responsibility / keyword) into the requirement table; show the parsed result for my review and correction before saving. Reference repos/ for the supabase-js API. Plan first; wait for approval.

M4 — Coverage Map
Read AGENTS.md. Plan Milestone 4: given a job, compute coverage — for each requirement, match against facts (LLM-assisted matching with structured output returning fact IDs and status met/partial/unmet). Render the coverage map with linked evidence. Unmet requirements must be displayed plainly, never hidden. Plan first; wait for approval.

M5 — Provenance Generation (the heart — budget extra care)
Read AGENTS.md, especially the core invariant. Plan Milestone 5 in two parts. Part A: the validation layer in src/lib/provenance/ — given generated lines with fact_id citations, verify every line cites ≥1 valid fact, citations support the text, and no banned words appear; invalid lines are rejected with reasons. Write thorough tests for Part A. Part B: resume generation — select relevant facts for the job, generate lines WITH citations via structured output, pass through validation, and present an approval UI where I accept/reject each line. Rejected or uncited content must never reach the document. Split into two PRs. Plan first; wait for approval.

M6 — Cover Letter + Voice
Read AGENTS.md. Plan Milestone 6: cover letter generation conditioned on my writing_sample facts so output matches my voice, with the same citation + validation + approval pipeline as the resume. Plan first; wait for approval.

M7 — Export
Read AGENTS.md. Plan Milestone 7: export approved documents as a clean, professional PDF — one excellent template only. Choose a battle-tested PDF approach (no package younger than 14 days) and justify the choice from repos/ or established libraries. Plan first; wait for approval.

Closing ritual (end of EVERY session, same session)
Structure pass:
Review only the code you wrote this session. Where did you duplicate logic that exists elsewhere in src/lib? Consolidate into reusable functions. Do not refactor unrelated code.

Self-review:
List the three weakest points of this milestone's code — honestly. Fix any that are genuine defects; leave style preferences alone.

Commit, small PR.
Cross-review (after each PR, in the Codex panel)
Review this PR critically: correctness, security (we store personal career data), and whether anything weakens the provenance invariant described in AGENTS.md. Report issues with file/line references. Do not rewrite code; report only. Feed Codex's findings back to Claude Code to fix. Repeat until the review is clean. (If you later add Greptile, its /greploop replaces this manual loop.)

When context grows heavy
Start a new session. Do not use /compact. The new session begins by reading AGENTS.md — that is what it's for.