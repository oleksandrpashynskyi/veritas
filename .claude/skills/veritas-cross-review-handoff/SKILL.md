---
name: veritas-cross-review-handoff
description: Hand a Veritas branch to the cross-reviewer (Codex) for a critical, report-only review covering correctness, security of personal career data, and any weakening of the provenance invariant. Produces a file/line issue list; loop until clean.
disable-model-invocation: true
argument-hint: "[branch or PR ref]"
---

# Veritas cross-review handoff

Cross-review each PR with the other agent (Codex reviews Claude Code's work and vice
versa) until clean. Target: $ARGUMENTS (branch or PR; default = current branch).

## The review prompt to give the reviewer
> Review this branch critically: correctness, security (we store the user's personal
> career data), and whether anything weakens the provenance invariant described in
> AGENTS.md. Report issues with file/line references. Do not rewrite code; report only.

## The loop
1. Point the reviewer at the branch/PR with the prompt above.
2. Collect findings — each must cite `file:line`.
3. Bring findings back here, fix in code, re-request review.
4. Repeat until the review is clean.

## Constraints
- Reviewer **reports only** — no rewriting. Findings without a `file:line` reference
  go back for specifics.
- Fixes are judged on merits, not applied blindly — a questionable finding is
  discussed, not auto-accepted.
- If a review fix touches `supabase/migrations/**` or `src/lib/provenance/**`, re-run
  `/veritas-invariant-smoke-test` before the fix is committed.
- If an automated reviewer (e.g. Greptile `/greploop`) is added later, it replaces
  this manual loop.
