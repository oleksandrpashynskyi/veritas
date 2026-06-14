---
name: veritas-closing-ritual
description: End-of-milestone ritual for Veritas. A structure/dedup pass over only this session's new code, then an honest self-review naming the three weakest points of the milestone. Run when wrapping up a milestone, before the commit.
disable-model-invocation: true
argument-hint: "(no arguments)"
---

# Veritas closing ritual

Run at the end of a milestone, in the same session, before committing.

## 1. Structure / dedup pass
Review **only the code you wrote this session** — not unrelated code. Where did you
duplicate logic that already exists in `src/lib/`? Consolidate into a reusable
function (search `src/lib/` before writing any new helper, per AGENTS.md). Report
what you consolidated.

## 2. Honest self-review
List the **three weakest points** of this milestone's code — honestly, not
performatively. For each: genuine defect or style preference? Fix the genuine
defects now; leave style preferences. State which you fixed and which you left.

## Constraints
- Analysis plus targeted fixes — not a rewrite, and no scope creep into other code.
- If a weak point touches the provenance layer, the fix ships with a test (AGENTS.md:
  tests for the provenance layer on every change that touches it).
- This ritual does not bless skipping verification — run
  `/veritas-invariant-smoke-test` separately if migrations or the provenance layer
  changed.
