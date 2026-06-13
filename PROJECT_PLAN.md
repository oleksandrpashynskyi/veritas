Veritas — The Truthful Resume Tailor
V1 Project Plan
One sentence: Paste a job description, receive a tailored resume and cover letter in which every line is provably sourced from your real, verified experience — and an honest account of where you don't qualify.

1. The One Core Problem
Every AI resume tool on the market fabricates (hallucinated skills, inflated budgets), homogenizes ("resume soup" that 49% of hiring managers auto-dismiss), or sells false certainty (ATS scores that vary 24 points between identical runs). We solve exactly one problem: tailoring that cannot lie.

The hard engineering core is the provenance engine: generated text is structurally forced to cite source facts. A claim without a source cannot be rendered. This is a validation-layer problem, not a prompt-engineering problem — prompts ask nicely; our renderer enforces.

2. Product Principles (the negation of the market's sins)
No fabrication. Every resume line carries fact-ID citations to the master profile. Uncited lines are rejected by the system, not by politeness.
No resume soup. Output is generated in the user's voice, learned from their writing samples. Banned-word list ("spearheaded," "leveraged," "synergize"...) enforced at validation.
No false certainty. We will never show an "ATS score." We show a requirements-coverage map: met / partially met / not met, each with evidence or its absence.
Honest gaps. Where the user doesn't qualify, the tool says so and offers the truthful framing — never the inflated one.
Every edit approved. Nothing lands in a document without explicit user approval, diff-style.
No dark patterns, ever. (Future concern; v1 has one user: us.)
3. V1 Scope
In
Master Profile: structured store of atomic facts (experiences, achievements with real metrics, skills, education, writing samples). Each fact has a stable ID. Entered once, edited rarely.
Job Ingest: paste a job description → extract structured requirements (must-have, nice-to-have, responsibilities, keywords).
Coverage Map: requirements × facts matrix. Met / partial / unmet, with linked evidence.
Tailored Resume Generation: selects and rewrites relevant facts for this job; every line cites fact IDs; validation layer rejects uncited or banned-word content; approval UI with per-change accept/reject.
Cover Letter Generation: same provenance rules, user's voice.
Export: clean PDF (one excellent template, not a gallery).
Out (refuse all temptation)
Job scraping / search
Application auto-fill
ATS scores
Tracking boards / CRM
Template galleries
Accounts, auth, payments, multi-user
Mobile
4. Architecture
Frontend: Next.js 15 (App Router), TypeScript, Tailwind, shadcn/ui
Backend: Next.js server actions / route handlers (monolith; no separate service in v1)
Database: Supabase Postgres (free tier) — but local-first: single user, simple schema
LLM: Anthropic API for generation steps (structured outputs with fact citations). Note: app runtime calls are API-billed — keep generation steps few and cached. Claude Code (subscription) is for building, the API is for running.
Deploy: local dev only for v1; Vercel later if it leaves the nest
Data model sketch
fact          (id, type[experience|achievement|skill|education|writing_sample],
               content, employer, role, date_start, date_end, metrics_json, verified bool)
job           (id, raw_text, company, title, created_at)
requirement   (id, job_id, text, kind[must|nice|responsibility|keyword])
coverage      (job_id, requirement_id, status[met|partial|unmet], fact_ids[])
document      (id, job_id, type[resume|cover_letter], status[draft|approved])
doc_line      (id, document_id, text, fact_ids[] NOT EMPTY, approved bool)
The invariant that is the product: doc_line.fact_ids must be non-empty and valid, or the line does not exist.

5. Milestones (one per session, small PRs)
M1 — Scaffold. Next.js + Supabase wired, schema migrated, repos/ populated via opensrc, AGENTS.md in root.
M2 — Master Profile. CRUD for facts. Seed it with the founder's real career data.
M3 — Job Ingest. Paste → parsed requirements (LLM structured extraction), stored.
M4 — Coverage Map. Matching of requirements to facts; honest unmet display.
M5 — Provenance Generation (the heart). Resume generation with enforced citations + validation layer + approval UI.
M6 — Cover Letter + Voice. Writing-sample-conditioned generation, same enforcement.
M7 — Export. One beautiful PDF template.
M8 — Live Fire. Founder applies to 10 real jobs through it. Fix what bleeds.
6. Working Rules (Micky's method, our law)
One milestone = one session = one small PR. New session > /compact.
Plan first; founder trims the plan before any code is written.
After every milestone: run the structure/refactor skill (kill duplication, service layer).
Cross-review: Codex reviews Claude Code's PRs and vice versa, until clean.
Never install a package younger than 14 days.
Founders think; employees (agents) labor.
