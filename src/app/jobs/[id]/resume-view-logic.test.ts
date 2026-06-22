import { describe, expect, it } from "vitest";
import { buildResumeRows, type CitedFact } from "./resume-view-logic";

const F1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const F2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MISSING = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const facts: CitedFact[] = [
  { id: F1, content: "Built the payments service", verified: true },
  { id: F2, content: "Cut deploy time to 5 minutes", verified: true },
];

describe("buildResumeRows", () => {
  it("resolves each line's fact_ids to evidence, in order, preserving text", () => {
    const rows = buildResumeRows(
      [
        { text: "Owned payments end to end", fact_ids: [F1] },
        { text: "Sped up delivery", fact_ids: [F2, F1] },
      ],
      facts,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].text).toBe("Owned payments end to end");
    expect(rows[0].evidence.map((f) => f.content)).toEqual(["Built the payments service"]);
    expect(rows[1].evidence.map((f) => f.content)).toEqual([
      "Cut deploy time to 5 minutes",
      "Built the payments service",
    ]);
  });

  it("drops a cited fact_id that does not resolve to a known fact (defensive)", () => {
    const rows = buildResumeRows([{ text: "x", fact_ids: [F1, MISSING] }], facts);
    expect(rows[0].evidence.map((f) => f.id)).toEqual([F1]);
  });
});
