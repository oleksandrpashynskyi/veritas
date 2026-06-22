// Pure view logic for the résumé — split out of resume-view.tsx so it is unit-testable
// (resume-view-logic.test.ts) WITHOUT a DOM or the `@/` alias. It resolves each line's cited fact_ids
// to the evidence shown beneath it, so the live preview (resume-compute.tsx) and the stored résumé
// (page.tsx) render from the SAME logic and can never drift.

// A fact as cited beneath a résumé line: just enough to show the source content + its verified badge.
// Every cited fact is verified by construction (persistResume's verified-only gate), but we carry the
// flag so the display reads honestly from the data rather than asserting it.
export type CitedFact = { id: string; content: string; verified: boolean };

export type ResumeLineInput = { text: string; fact_ids: string[] };

export type ResumeLineView = {
  text: string;
  fact_ids: string[];
  evidence: CitedFact[];
};

// Resolve each line's fact_ids to evidence (in cited order), dropping any id that does not resolve to
// a known fact — defensive only; a stored line cites real facts (DB trigger), so this never drops in
// practice. Preserves line order + text.
export function buildResumeRows(
  lines: ResumeLineInput[],
  facts: CitedFact[],
): ResumeLineView[] {
  const factById = new Map(facts.map((f) => [f.id, f]));
  return lines.map((line) => ({
    text: line.text,
    fact_ids: line.fact_ids,
    evidence: line.fact_ids
      .map((id) => factById.get(id))
      .filter((f): f is CitedFact => Boolean(f)),
  }));
}
