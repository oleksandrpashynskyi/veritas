import { describe, expect, it } from "vitest";
import { reconcileCitations, validateCoverage } from "./coverage-schema";

// Valid v4-shaped UUIDs for the fixtures. validateCoverage rejects anything that isn't UUID-shaped,
// so non-UUID placeholders ("req-1", "fact_a") would be caught structurally — these are real-shaped.
const R1 = "11111111-1111-4111-8111-111111111111";
const R2 = "22222222-2222-4222-8222-222222222222";
const F1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const F2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FOREIGN_FACT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FOREIGN_REQ = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

// validateCoverage is the "trust the parse, not the prose" boundary for M4: it runs on the matcher's
// structured output AND again on the client-submitted preview payload at save time. It must FAIL
// CLOSED — any malformed, off-shape, or self-inconsistent structure is rejected, never stored. It is
// the STRUCTURAL half; fact_id / requirement_id ownership (realness) is reconcileCitations' job.
describe("validateCoverage", () => {
  const valid = {
    coverage: [
      { requirement_id: R1, status: "met", fact_ids: [F1] },
      { requirement_id: R2, status: "unmet", fact_ids: [] },
    ],
  };

  it("accepts a well-formed coverage and returns the normalized value", () => {
    const r = validateCoverage(valid);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({
        coverage: [
          { requirement_id: R1, status: "met", fact_ids: [F1] },
          { requirement_id: R2, status: "unmet", fact_ids: [] },
        ],
      });
    }
  });

  it("accepts an empty coverage array (every requirement defaults to unmet at reconcile time)", () => {
    const r = validateCoverage({ coverage: [] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.coverage).toEqual([]);
  });

  it("accepts met and partial with evidence and unmet without", () => {
    const r = validateCoverage({
      coverage: [
        { requirement_id: R1, status: "met", fact_ids: [F1, F2] },
        { requirement_id: R2, status: "partial", fact_ids: [F1] },
      ],
    });
    expect(r.ok).toBe(true);
  });

  it("de-duplicates repeated fact_ids within an entry (normalizes)", () => {
    const r = validateCoverage({
      coverage: [{ requirement_id: R1, status: "met", fact_ids: [F1, F1, F2] }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.coverage[0].fact_ids).toEqual([F1, F2]);
  });

  it("drops unexpected properties on an entry (normalizes to the three fields)", () => {
    const r = validateCoverage({
      coverage: [
        { requirement_id: R1, status: "unmet", fact_ids: [], injected: "DROP ME" },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.coverage[0]).toEqual({
        requirement_id: R1,
        status: "unmet",
        fact_ids: [],
      });
    }
  });

  it("rejects a null root", () => {
    expect(validateCoverage(null).ok).toBe(false);
  });

  it("rejects a non-object root (array)", () => {
    expect(validateCoverage([]).ok).toBe(false);
  });

  it("rejects when coverage is missing", () => {
    expect(validateCoverage({}).ok).toBe(false);
  });

  it("rejects when coverage is not an array", () => {
    expect(validateCoverage({ coverage: "x" }).ok).toBe(false);
  });

  it("rejects an entry that is not an object", () => {
    expect(validateCoverage({ coverage: ["x"] }).ok).toBe(false);
  });

  it("rejects an entry missing requirement_id", () => {
    expect(
      validateCoverage({ coverage: [{ status: "unmet", fact_ids: [] }] }).ok,
    ).toBe(false);
  });

  it("rejects a non-UUID-shaped requirement_id (catches hallucinated placeholders)", () => {
    expect(
      validateCoverage({
        coverage: [{ requirement_id: "req-1", status: "unmet", fact_ids: [] }],
      }).ok,
    ).toBe(false);
  });

  it("rejects an unknown status", () => {
    expect(
      validateCoverage({
        coverage: [{ requirement_id: R1, status: "maybe", fact_ids: [] }],
      }).ok,
    ).toBe(false);
  });

  it("rejects when fact_ids is not an array", () => {
    expect(
      validateCoverage({
        coverage: [{ requirement_id: R1, status: "met", fact_ids: F1 }],
      }).ok,
    ).toBe(false);
  });

  it("rejects a non-UUID-shaped fact_id", () => {
    expect(
      validateCoverage({
        coverage: [{ requirement_id: R1, status: "met", fact_ids: ["fact_a"] }],
      }).ok,
    ).toBe(false);
  });

  it("rejects a null element inside fact_ids", () => {
    expect(
      validateCoverage({
        coverage: [{ requirement_id: R1, status: "met", fact_ids: [null] }],
      }).ok,
    ).toBe(false);
  });

  it("rejects met with no evidence (inflated-claim guard, mirrors the DB CHECK)", () => {
    expect(
      validateCoverage({
        coverage: [{ requirement_id: R1, status: "met", fact_ids: [] }],
      }).ok,
    ).toBe(false);
  });

  it("rejects partial with no evidence", () => {
    expect(
      validateCoverage({
        coverage: [{ requirement_id: R1, status: "partial", fact_ids: [] }],
      }).ok,
    ).toBe(false);
  });

  it("rejects unmet WITH evidence (an unmet must cite nothing)", () => {
    expect(
      validateCoverage({
        coverage: [{ requirement_id: R1, status: "unmet", fact_ids: [F1] }],
      }).ok,
    ).toBe(false);
  });

  it("rejects a duplicate requirement_id across entries", () => {
    expect(
      validateCoverage({
        coverage: [
          { requirement_id: R1, status: "met", fact_ids: [F1] },
          { requirement_id: R1, status: "unmet", fact_ids: [] },
        ],
      }).ok,
    ).toBe(false);
  });

  it("rejects an absurdly long coverage list", () => {
    const many = Array.from({ length: 201 }, (_, i) => ({
      requirement_id: R1.slice(0, -3) + String(100 + (i % 900)),
      status: "unmet",
      fact_ids: [],
    }));
    expect(validateCoverage({ coverage: many }).ok).toBe(false);
  });

  it("rejects an entry citing too many facts", () => {
    const tooMany = Array.from(
      { length: 51 },
      (_, i) => F1.slice(0, -3) + String(100 + i),
    );
    expect(
      validateCoverage({
        coverage: [{ requirement_id: R1, status: "met", fact_ids: tooMany }],
      }).ok,
    ).toBe(false);
  });
});

// reconcileCitations is the PURE provenance half: given already-validated entries plus the sets of
// the user's REAL owned fact ids and the job's REAL requirement ids (both built by the caller from
// the per-user/RLS client), it rejects any citation that is not owned/in-job, and fills any
// requirement the matcher omitted as `unmet` (honest default — unassessed = not met).
describe("reconcileCitations", () => {
  it("rejects an entry citing a fact_id the user does not own", () => {
    const r = reconcileCitations({
      entries: [{ requirement_id: R1, status: "met", fact_ids: [FOREIGN_FACT] }],
      ownedFactIds: new Set([F1]),
      jobRequirementIds: new Set([R1]),
    });
    expect(r.ok).toBe(false);
  });

  it("rejects an entry whose requirement_id is not part of the job", () => {
    const r = reconcileCitations({
      entries: [{ requirement_id: FOREIGN_REQ, status: "unmet", fact_ids: [] }],
      ownedFactIds: new Set([F1]),
      jobRequirementIds: new Set([R1]),
    });
    expect(r.ok).toBe(false);
  });

  it("accepts when every cited id is owned and in the job", () => {
    const r = reconcileCitations({
      entries: [{ requirement_id: R1, status: "met", fact_ids: [F1] }],
      ownedFactIds: new Set([F1, F2]),
      jobRequirementIds: new Set([R1]),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const row = r.rows.find((x) => x.requirement_id === R1);
      expect(row).toEqual({ requirement_id: R1, status: "met", fact_ids: [F1] });
    }
  });

  it("fills a requirement the matcher omitted as unmet with no evidence", () => {
    const r = reconcileCitations({
      entries: [{ requirement_id: R1, status: "met", fact_ids: [F1] }],
      ownedFactIds: new Set([F1]),
      jobRequirementIds: new Set([R1, R2]),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rows).toHaveLength(2);
      const r2 = r.rows.find((x) => x.requirement_id === R2);
      expect(r2).toEqual({ requirement_id: R2, status: "unmet", fact_ids: [] });
    }
  });

  it("with no entries, returns every job requirement as unmet", () => {
    const r = reconcileCitations({
      entries: [],
      ownedFactIds: new Set(),
      jobRequirementIds: new Set([R1, R2]),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rows).toHaveLength(2);
      expect(r.rows.every((x) => x.status === "unmet" && x.fact_ids.length === 0)).toBe(true);
    }
  });
});
