// Pure content-assembly for the PDF export (M7) — the fidelity-critical seam, split out so it is
// unit-testable (export-content.test.ts) and driven by verify-m7 WITHOUT a renderer, a DOM, or the `@/`
// alias. It takes the stored APPROVED document (the doc_lines + the cover letter's connective) plus the
// user's facts, and produces the EXACT ordered content the PDF will render — by REUSING the SAME
// view-logic resolvers the screen uses (buildResumeRows / buildCoverLetterRows). One resolution path
// feeds both screen and PDF, so the exported document can never silently drift from what was approved:
// the same writing_sample-excluded citation resolution, the same unresolved-id-shows-nothing behavior,
// the same position ordering. NO React-PDF / rendering concerns live here — pure content in, ordered
// content out. (Relative imports, not the `@/` alias, so this stays testable under vitest/tsx without
// alias config — exactly like resume-view-logic.ts.)
import { buildResumeRows, type CitedFact, type ResumeLineView } from "../resume-view-logic";
import {
  buildCoverLetterRows,
  type ConnectiveRowInput,
  type CoverLetterRow,
} from "../cover-letter-view-logic";

// The stored doc_line columns the export route selects: the claim `text` + its cited `fact_ids`, plus
// the two columns the assembly gates on — `position` (line order) and `approved`. Mirrors a doc_line row.
export type ExportLineInput = {
  text: string;
  fact_ids: string[];
  position: number;
  approved: boolean;
};

// Re-export the view types so the PDF templates and the route import the assembled shapes from one place.
export type { CitedFact, ResumeLineView, ConnectiveRowInput, CoverLetterRow };

// Select ONLY approved lines, in position order. The `approved === true` filter is defense-in-depth: a
// stored approved document's doc_lines are ALL approved=true (persistDocument sets them so, and only
// approved documents are ever stored), so on real data this drops nothing and the export's content is
// the screen's content. It is the export twin of the writing_sample dirty-row defense in the shared
// resolvers — should a dirty/out-of-band approved=false row ever exist, the PDF (like an audit) refuses
// to render it as approved content. The sort is the SAME order page.tsx delegates to the query's
// `.order("position")`; doing it here keeps this a self-contained pure function the proof can drive.
function approvedInOrder(lines: ExportLineInput[]): ExportLineInput[] {
  return lines.filter((l) => l.approved).slice().sort((a, b) => a.position - b.position);
}

// Résumé: the approved claim lines in position order, each resolved to its evidence through the SHARED
// resolver (writing_sample excluded; an unresolved id resolves to nothing). The PDF renders the line
// `text` (the employer-facing claim); the resolved evidence is carried for parity with the screen but
// the template does not print it (evidence is the on-screen provenance audit, not the sent artifact).
export function assembleResumeExport(
  lines: ExportLineInput[],
  facts: CitedFact[],
): ResumeLineView[] {
  return buildResumeRows(
    approvedInOrder(lines).map(({ text, fact_ids }) => ({ text, fact_ids })),
    facts,
  );
}

// Cover letter: the approved claim lines + the connective prose, merged into ONE ordered list by the
// shared position space and resolved through the SAME buildCoverLetterRows the screen uses — so the
// letter reads exactly as approved: claims sourced, connective as framing (no evidence). Connective
// rides on the document row and carries no `approved` flag of its own; it is part of the approved
// document by virtue of that document being stored, so it is passed through in full (the shared resolver
// does the position merge + ordering).
export function assembleCoverLetterExport(
  claimLines: ExportLineInput[],
  connective: ConnectiveRowInput[],
  facts: CitedFact[],
): CoverLetterRow[] {
  return buildCoverLetterRows(
    approvedInOrder(claimLines).map(({ text, fact_ids, position }) => ({ text, fact_ids, position })),
    connective,
    facts,
  );
}
