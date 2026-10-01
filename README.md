# Veritas

**AI résumé and cover-letter tailoring in which every generated claim must cite your verified experience.**

Paste a job description. Veritas extracts its requirements, maps them against a profile of atomic, verified facts, and generates a tailored résumé and cover letter. Every claim line carries the IDs of the facts it rests on; a line that cites nothing, or cites a fact that is not the user's own verified fact, is never stored.

> **Status:** in development, run locally. Milestones M1–M7 (scaffold through PDF export) are in this repository, each with its own verification script (`verify-m*.mjs`).

## What it does

- **Master profile** — experiences, achievements, skills, education and writing samples, stored as atomic facts with stable IDs.
- **Job ingest** — paste a job description; the Anthropic API extracts must-haves, nice-to-haves, responsibilities and keywords as structured output.
- **Coverage map** — each requirement is marked met, partial or unmet, with the facts that support it. There is deliberately no "ATS score".
- **Tailored résumé and cover letter** — generated from cited facts only, conditioned on the user's own writing samples for voice, and checked against a list of banned résumé clichés.
- **PDF export** — one clean template, rendered with `@react-pdf/renderer`.

## The provenance invariant

A stored document line must cite at least one fact, and every cited fact must exist. This is enforced in two places:

1. **In Postgres.** `doc_line.fact_ids` cannot be empty — a `cardinality()` check, because an `array_length()` check returns NULL for an empty array and a NULL check passes — and a trigger rejects IDs that do not reference a real fact.
2. **In the app.** `src/lib/provenance/` accepts citations only from the signed-in user's own verified facts. Writing samples shape tone but can never be cited as evidence. If any step fails, nothing is stored.

A citation makes a claim checkable against its source. It does not by itself prove that the generated wording is accurate.

## Data isolation

Supabase Auth with row-level security on every table: deny-by-default for anonymous access, per-user ownership for signed-in users. The app's user-data path uses a per-user client, so RLS applies to every query; the service-role key is server-only and used for administration and the verification scripts.

## Stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS 4 · Supabase (PostgreSQL, Auth) · Anthropic API · `@react-pdf/renderer` · Vitest

## Run it locally

Requires Node.js 20+ and Docker (for the local Supabase stack).

```bash
npm install
cp .env.example .env.local   # fill in the Supabase URL/keys and an Anthropic API key
npx supabase start           # local Postgres + Auth; applies supabase/migrations
npm run seed                 # optional: a test account (dev@veritas.test) with sample facts
npm run dev                  # http://localhost:3000
npm test                     # unit tests (Vitest)
```

## How it's built

Planned and reviewed milestone by milestone with AI coding agents, which cross-review each other's changes. The rules they work under — including "never weaken the provenance layer" — are in [`AGENTS.md`](AGENTS.md); the product plan is in [`PROJECT_PLAN.md`](PROJECT_PLAN.md).

---

Part of [Oleksandr Pashynskyi's portfolio](https://oleksandrpashynskyi.com/veritas).
