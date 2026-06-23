// Pure view logic for the cover letter — split out of cover-letter-view.tsx so it is unit-testable
// (cover-letter-view-logic.test.ts) WITHOUT a DOM or the `@/` alias. It merges the cited CLAIM lines
// and the CONNECTIVE segments into ONE ordered list (by the shared position), resolves each claim's
// evidence, and attaches the experiential-language advisory to each connective row — so the live
// preview (cover-letter-compute.tsx) and the stored letter (page.tsx) render from the SAME logic and
// can never drift. Mirrors resume-view-logic.ts; reuses its CitedFact type.
// Relative import (not the `@/` alias) so this stays unit-testable under vitest without alias config,
// exactly like resume-view-logic.ts. The chain it pulls in (cover-letter-schema -> resume-schema,
// banned) is pure — no SDK, no server-only — so it is safe in a client component too.
import { findExperientialLanguage } from "../../../lib/llm/cover-letter-schema";
import type { CitedFact } from "./resume-view-logic";

export type ClaimRowInput = { text: string; fact_ids: string[]; position: number };
export type ConnectiveRowInput = { role: string; text: string; position: number };

export type CoverLetterRow =
  | {
      kind: "claim";
      position: number;
      text: string;
      fact_ids: string[];
      evidence: CitedFact[];
    }
  | {
      kind: "connective";
      position: number;
      role: string;
      text: string;
      // Advisory only (findExperientialLanguage): a hint that a claim may be hiding in framing. Never a
      // rejection — the connective is still shown and acceptable.
      warn: string[];
    };

// Merge claims + connective into one ordered list (by the shared position space), resolve each claim's
// fact_ids to evidence (in cited order, dropping any id that does not resolve — defensive only; a
// stored claim cites real facts via the DB trigger), and flag any experiential language in connective.
export function buildCoverLetterRows(
  claimLines: ClaimRowInput[],
  connective: ConnectiveRowInput[],
  facts: CitedFact[],
): CoverLetterRow[] {
  // Exclude voice-only writing samples from resolution — a cited id that resolves to a writing sample
  // (only possible from a dirty/out-of-band row; every write path is sealed) renders as NOTHING, like
  // any unresolved id. Defense-in-depth so the display never asserts a sample as evidence.
  const factById = new Map(
    facts.filter((f) => f.type !== "writing_sample").map((f) => [f.id, f]),
  );
  const rows: CoverLetterRow[] = [];

  for (const line of claimLines) {
    rows.push({
      kind: "claim",
      position: line.position,
      text: line.text,
      fact_ids: line.fact_ids,
      evidence: line.fact_ids
        .map((id) => factById.get(id))
        .filter((f): f is CitedFact => Boolean(f)),
    });
  }

  for (const seg of connective) {
    rows.push({
      kind: "connective",
      position: seg.position,
      role: seg.role,
      text: seg.text,
      warn: findExperientialLanguage(seg.text),
    });
  }

  rows.sort((a, b) => a.position - b.position);
  return rows;
}
