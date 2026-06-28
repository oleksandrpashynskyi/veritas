import { describe, expect, it } from "vitest";
import {
  assembleResumeExport,
  assembleCoverLetterExport,
  type ExportLineInput,
} from "./export-content";
import type { CitedFact } from "./export-content";

// assembleResumeExport / assembleCoverLetterExport are the M7 export's fidelity seam: they take the
// stored approved document (doc_lines + connective) and produce the EXACT ordered content the PDF
// renders, REUSING the screen's buildResumeRows / buildCoverLetterRows resolvers. These tests pin the
// export-specific behavior layered on top of that shared resolution — approved-only selection and
// position ordering — and confirm the inherited resolution (writing_sample excluded, unresolved id
// shows nothing) survives the export path. Mirrors resume-view-logic.test.ts + cover-letter-view-logic.test.ts.
const facts: CitedFact[] = [
  { id: "f1", content: "Built the billing system", verified: true },
  { id: "f2", content: "Led the data migration", verified: true },
  // A voice-only writing sample — verified + owned, but NEVER citable as evidence by a claim line.
  { id: "ws", content: "a paragraph of my prose", verified: true, type: "writing_sample" },
];

const line = (
  text: string,
  fact_ids: string[],
  position: number,
  approved = true,
): ExportLineInput => ({ text, fact_ids, position, approved });

describe("assembleResumeExport", () => {
  it("emits only approved lines, in position order (the unapproved line never appears)", () => {
    const rows = assembleResumeExport(
      [
        line("Second", ["f1"], 2),
        line("First", ["f2"], 0),
        line("UNAPPROVED", ["f1"], 1, false), // approved=false → must be dropped
        line("Third", ["f1"], 3),
      ],
      facts,
    );
    expect(rows.map((r) => r.text)).toEqual(["First", "Second", "Third"]);
    expect(rows.some((r) => r.text === "UNAPPROVED")).toBe(false);
  });

  it("resolves each line's evidence through the shared resolver, in cited order", () => {
    const rows = assembleResumeExport([line("Both", ["f2", "f1"], 0)], facts);
    expect(rows[0].evidence.map((e) => e.id)).toEqual(["f2", "f1"]);
  });

  it("excludes a cited writing_sample from evidence (the line still appears; its evidence is empty)", () => {
    const rows = assembleResumeExport([line("Voice-cited", ["ws"], 0)], facts);
    expect(rows.map((r) => r.text)).toEqual(["Voice-cited"]); // approved content still rendered
    expect(rows[0].evidence).toEqual([]); // writing_sample never resolves as evidence
  });

  it("drops an unresolved fact_id from evidence but preserves the raw fact_ids (defensive)", () => {
    const rows = assembleResumeExport([line("x", ["f1", "ghost"], 0)], facts);
    expect(rows[0].evidence.map((e) => e.id)).toEqual(["f1"]);
    expect(rows[0].fact_ids).toEqual(["f1", "ghost"]);
  });
});

describe("assembleCoverLetterExport", () => {
  it("merges approved claims + connective into one list ordered by position; drops unapproved claims", () => {
    const rows = assembleCoverLetterExport(
      [
        line("Built it", ["f1"], 2),
        line("UNAPPROVED claim", ["f1"], 4, false), // dropped
      ],
      [
        { role: "greeting", text: "Dear Hiring Manager,", position: 0 },
        { role: "interest", text: "I'm writing about the role.", position: 1 },
        { role: "closing", text: "Thanks for your time.", position: 3 },
      ],
      facts,
    );
    expect(rows.map((r) => r.position)).toEqual([0, 1, 2, 3]);
    expect(rows.map((r) => r.kind)).toEqual(["connective", "connective", "claim", "connective"]);
    expect(rows.some((r) => r.text === "UNAPPROVED claim")).toBe(false);
  });

  it("excludes a cited writing_sample from a claim's evidence", () => {
    const rows = assembleCoverLetterExport([line("Voice-cited", ["f1", "ws"], 0)], [], facts);
    if (rows[0].kind !== "claim") throw new Error("expected a claim row");
    expect(rows[0].evidence.map((e) => e.id)).toEqual(["f1"]);
  });

  it("carries connective as framing (no evidence) with its role", () => {
    const rows = assembleCoverLetterExport(
      [],
      [{ role: "interest", text: "Your mission resonates with me", position: 0 }],
      facts,
    );
    if (rows[0].kind !== "connective") throw new Error("expected a connective row");
    expect(rows[0].role).toBe("interest");
  });
});
