import { describe, expect, it } from "vitest";
import {
  buildCoverageRows,
  isProvisional,
  type CoverageRow,
  type ViewFact,
  type ViewRequirement,
} from "./coverage-view-logic";

function fact(id: string, verified: boolean): ViewFact {
  return { id, type: "skill", content: `fact ${id}`, employer: null, role: null, verified };
}
function req(id: string): ViewRequirement {
  return { id, text: `req ${id}`, kind: "must" };
}
function row(status: CoverageRow["status"], evidence: ViewFact[]): CoverageRow {
  return { requirement: req("r1"), status, evidence };
}

// The rule under test: a met/partial is provisional if ANY cited fact is unverified (not only when
// ALL are). The model cites a joint set, so one unconfirmed fact means the full claim is unconfirmed.
describe("isProvisional", () => {
  it("is true for a met whose every cited fact is unverified", () => {
    expect(isProvisional(row("met", [fact("a", false), fact("b", false)]))).toBe(true);
  });

  it("is true for a met with MIXED evidence — one verified, one unverified", () => {
    expect(isProvisional(row("met", [fact("a", true), fact("b", false)]))).toBe(true);
  });

  it("is false for a met whose every cited fact is verified", () => {
    expect(isProvisional(row("met", [fact("a", true), fact("b", true)]))).toBe(false);
  });

  it("is true for a partial with a single unverified fact", () => {
    expect(isProvisional(row("partial", [fact("a", false)]))).toBe(true);
  });

  it("is false for a partial whose every cited fact is verified", () => {
    expect(isProvisional(row("partial", [fact("a", true)]))).toBe(false);
  });

  it("is false for unmet (no claim is made)", () => {
    expect(isProvisional(row("unmet", []))).toBe(false);
  });
});

describe("buildCoverageRows", () => {
  it("builds one row per requirement in order, resolving evidence by id", () => {
    const requirements = [req("r1"), req("r2")];
    const facts = [fact("f1", true), fact("f2", false)];
    const entries = [
      { requirement_id: "r1", status: "met" as const, fact_ids: ["f1"] },
      { requirement_id: "r2", status: "partial" as const, fact_ids: ["f2"] },
    ];
    const rows = buildCoverageRows(entries, requirements, facts);
    expect(rows.map((r) => r.requirement.id)).toEqual(["r1", "r2"]);
    expect(rows[0].evidence.map((f) => f.id)).toEqual(["f1"]);
    expect(rows[1].status).toBe("partial");
  });

  it("defaults a requirement the matcher omitted to unmet with no evidence", () => {
    const rows = buildCoverageRows([], [req("r1")], []);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("unmet");
    expect(rows[0].evidence).toEqual([]);
  });

  it("does not render a cited writing_sample as coverage evidence (dirty-row defense-in-depth)", () => {
    // A cited id resolving to a voice-only writing sample (only possible from a dirty/out-of-band row)
    // must render as NOTHING, like an unresolved id — so the map never shows a sample as evidence a
    // requirement is met; the requirement's other valid evidence still shows.
    const sample: ViewFact = {
      id: "ws",
      type: "writing_sample",
      content: "my prose",
      employer: null,
      role: null,
      verified: true,
    };
    const rows = buildCoverageRows(
      [{ requirement_id: "r1", status: "met" as const, fact_ids: ["f1", "ws"] }],
      [req("r1")],
      [fact("f1", true), sample],
    );
    expect(rows[0].evidence.map((f) => f.id)).toEqual(["f1"]);
  });
});
