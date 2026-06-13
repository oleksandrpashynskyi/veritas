AGENTS.md — Veritas (Truthful Resume Tailor)
Vision (read this first)
This app produces tailored resumes and cover letters in which every line is provably sourced from the user's verified master profile. The product is trust. A fabricated or uncited claim is not a bug — it is the failure of the entire product. When in doubt, refuse to generate rather than invent.

What you (the agent) must know that isn't obvious from the code
The core invariant: doc_line.fact_ids must be non-empty and reference real facts. The validation layer (src/lib/provenance/) enforces this. Never weaken, bypass, or "temporarily disable" it.
No ATS scores. Do not add scoring features even if they seem helpful. We show requirement coverage (met/partial/unmet) with evidence only.
Banned-words list lives in src/lib/provenance/banned.ts ("spearheaded", "leveraged", "synergize", etc.). Generation output containing them fails validation.
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