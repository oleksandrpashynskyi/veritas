import { describe, expect, it } from "vitest";
import { buildCoverLetterRows } from "./cover-letter-view-logic";
import type { CitedFact } from "./resume-view-logic";

// buildCoverLetterRows assembles the stored/previewed cover letter: it merges cited CLAIM lines and
// CONNECTIVE segments into ONE ordered list (by the shared position), resolves each claim's evidence,
// and attaches the experiential-language advisory to each connective row. The preview
// (cover-letter-compute.tsx) and the stored letter (page.tsx) render from this SAME logic so they can
// never drift — exactly as buildResumeRows does for the résumé.
const facts: CitedFact[] = [
  { id: "f1", content: "Built the billing system", verified: true },
  { id: "f2", content: "Led the data migration", verified: true },
];

describe("buildCoverLetterRows", () => {
  it("merges claims and connective into one list ordered by the shared position (interleaving)", () => {
    const rows = buildCoverLetterRows(
      [{ text: "Built it", fact_ids: ["f1"], position: 2 }],
      [
        { role: "greeting", text: "Dear Hiring Manager,", position: 0 },
        { role: "interest", text: "I'm writing about the role.", position: 1 },
        { role: "closing", text: "Thanks for your time.", position: 3 },
      ],
      facts,
    );
    expect(rows.map((r) => r.position)).toEqual([0, 1, 2, 3]);
    expect(rows.map((r) => r.kind)).toEqual(["connective", "connective", "claim", "connective"]);
  });

  it("resolves a claim's evidence by fact_id in cited order", () => {
    const rows = buildCoverLetterRows(
      [{ text: "Did both", fact_ids: ["f2", "f1"], position: 0 }],
      [],
      facts,
    );
    expect(rows[0].kind).toBe("claim");
    if (rows[0].kind !== "claim") return;
    expect(rows[0].evidence.map((e) => e.id)).toEqual(["f2", "f1"]);
  });

  it("drops a fact_id that does not resolve (defensive) but preserves the raw fact_ids", () => {
    const rows = buildCoverLetterRows(
      [{ text: "x", fact_ids: ["f1", "ghost"], position: 0 }],
      [],
      facts,
    );
    if (rows[0].kind !== "claim") throw new Error("expected a claim row");
    expect(rows[0].evidence.map((e) => e.id)).toEqual(["f1"]);
    expect(rows[0].fact_ids).toEqual(["f1", "ghost"]);
  });

  it("carries the role on a connective row and leaves a clean sentiment un-flagged", () => {
    const rows = buildCoverLetterRows(
      [],
      [{ role: "interest", text: "Your mission resonates with me", position: 0 }],
      [],
    );
    if (rows[0].kind !== "connective") throw new Error("expected a connective row");
    expect(rows[0].role).toBe("interest");
    expect(rows[0].warn).toEqual([]);
  });

  it("flags a connective row that smuggles experiential language (advisory)", () => {
    const rows = buildCoverLetterRows(
      [],
      [{ role: "fit", text: "Your mission resonates, having shipped ML systems for years", position: 0 }],
      [],
    );
    if (rows[0].kind !== "connective") throw new Error("expected a connective row");
    expect(rows[0].warn.length).toBeGreaterThan(0);
  });
});
