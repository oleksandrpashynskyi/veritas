import { describe, expect, it } from "vitest";
import { reconcileResumeCitations, validateResume } from "./resume-schema";

// Valid v4-shaped UUIDs for the fixtures. validateResume rejects anything that isn't UUID-shaped,
// so non-UUID placeholders ("fact-1") are caught structurally — these are real-shaped.
const F1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const F2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FOREIGN_FACT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

// validateResume is the "trust the parse, not the prose" boundary for M5: it runs on the generator's
// structured output AND again on the client-submitted accepted-subset at save time (persistResume).
// It must FAIL CLOSED — any malformed, off-shape line, an uncited line, or a banned word is rejected,
// never stored. It is the STRUCTURAL + banned-word half; fact_id realness/ownership/VERIFIED is
// reconcileResumeCitations' job (proven against the DB by persistResume + verify-m5, not here).
describe("validateResume", () => {
  const valid = {
    lines: [
      { text: "Built the payments service end to end", fact_ids: [F1] },
      { text: "Cut deploy time from 30 to 5 minutes", fact_ids: [F1, F2] },
    ],
  };

  it("accepts a well-formed resume and returns the normalized value", () => {
    const r = validateResume(valid);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({
        lines: [
          { text: "Built the payments service end to end", fact_ids: [F1] },
          { text: "Cut deploy time from 30 to 5 minutes", fact_ids: [F1, F2] },
        ],
      });
    }
  });

  it("accepts an empty lines array (the empty-document rejection is persistResume's job, not the pure validator's)", () => {
    const r = validateResume({ lines: [] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.lines).toEqual([]);
  });

  it("de-duplicates repeated fact_ids within a line (normalizes)", () => {
    const r = validateResume({
      lines: [{ text: "Owned the API", fact_ids: [F1, F1, F2] }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.lines[0].fact_ids).toEqual([F1, F2]);
  });

  it("trims surrounding whitespace on text (normalizes)", () => {
    const r = validateResume({
      lines: [{ text: "  Shipped the thing  ", fact_ids: [F1] }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.lines[0].text).toBe("Shipped the thing");
  });

  it("drops unexpected properties on a line (normalizes to the two fields)", () => {
    const r = validateResume({
      lines: [{ text: "Did the work", fact_ids: [F1], injected: "DROP ME" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.lines[0]).toEqual({ text: "Did the work", fact_ids: [F1] });
    }
  });

  it("rejects a null root", () => {
    expect(validateResume(null).ok).toBe(false);
  });

  it("rejects a non-object root (array)", () => {
    expect(validateResume([]).ok).toBe(false);
  });

  it("rejects when lines is missing", () => {
    expect(validateResume({}).ok).toBe(false);
  });

  it("rejects when lines is not an array", () => {
    expect(validateResume({ lines: "x" }).ok).toBe(false);
  });

  it("rejects a line that is not an object", () => {
    expect(validateResume({ lines: ["x"] }).ok).toBe(false);
  });

  it("rejects a line missing text", () => {
    expect(validateResume({ lines: [{ fact_ids: [F1] }] }).ok).toBe(false);
  });

  it("rejects a non-string text", () => {
    expect(validateResume({ lines: [{ text: 5, fact_ids: [F1] }] }).ok).toBe(false);
  });

  it("rejects empty / whitespace-only text", () => {
    expect(validateResume({ lines: [{ text: "   ", fact_ids: [F1] }] }).ok).toBe(false);
  });

  // THE cited-check (rejection i) — the structural half of the provenance invariant: a line that
  // cites nothing must never exist. The DB CHECK doc_line_fact_ids_not_empty mirrors this; we reject
  // it here, before the DB, so it can never reach a draft or a store.
  it("rejects a line with empty fact_ids (the cited-check)", () => {
    expect(validateResume({ lines: [{ text: "Unsourced claim", fact_ids: [] }] }).ok).toBe(false);
  });

  it("rejects when fact_ids is not an array", () => {
    expect(validateResume({ lines: [{ text: "x", fact_ids: F1 }] }).ok).toBe(false);
  });

  it("rejects a non-UUID-shaped fact_id (catches hallucinated placeholders)", () => {
    expect(validateResume({ lines: [{ text: "x", fact_ids: ["fact-1"] }] }).ok).toBe(false);
  });

  it("rejects a null element inside fact_ids", () => {
    expect(validateResume({ lines: [{ text: "x", fact_ids: [null] }] }).ok).toBe(false);
  });

  // The banned-word rejection (rejection ii). Whole-word, case-insensitive matching lives in
  // findBannedWords (banned.test.ts); here we only assert validateResume rejects when it fires.
  it("rejects a line whose text contains a banned word (lowercase)", () => {
    expect(
      validateResume({ lines: [{ text: "leveraged the platform", fact_ids: [F1] }] }).ok,
    ).toBe(false);
  });

  it("rejects a banned word regardless of case", () => {
    expect(
      validateResume({ lines: [{ text: "Spearheaded the migration", fact_ids: [F1] }] }).ok,
    ).toBe(false);
  });

  it("accepts a clean line whose text only resembles a banned word (whole-word boundary)", () => {
    // "wizardry" must not trip the banned entry "wizard" — the line is truthful and sourced.
    const r = validateResume({ lines: [{ text: "Practised SQL wizardry", fact_ids: [F1] }] });
    expect(r.ok).toBe(true);
  });

  it("rejects an absurdly long lines list", () => {
    const many = Array.from({ length: 61 }, () => ({ text: "A line", fact_ids: [F1] }));
    expect(validateResume({ lines: many }).ok).toBe(false);
  });

  it("rejects a line citing too many facts", () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => F1.slice(0, -3) + String(100 + i));
    expect(validateResume({ lines: [{ text: "x", fact_ids: tooMany }] }).ok).toBe(false);
  });
});

// reconcileResumeCitations is the PURE provenance half: given already-validated lines plus the set of
// the user's REAL verified+owned fact ids (built by the caller from the per-user/RLS client with
// `.eq("verified", true)`), it rejects the WHOLE payload if any line cites an id outside that set —
// closing realness, ownership, and the VERIFIED-only rule at once. All-or-nothing, like the M4 core.
describe("reconcileResumeCitations", () => {
  it("rejects a line citing a fact_id not in the verified-owned set", () => {
    const r = reconcileResumeCitations({
      lines: [{ text: "Built it", fact_ids: [FOREIGN_FACT] }],
      verifiedOwnedFactIds: new Set([F1]),
    });
    expect(r.ok).toBe(false);
  });

  it("accepts when every cited id is in the verified-owned set", () => {
    const r = reconcileResumeCitations({
      lines: [{ text: "Built it", fact_ids: [F1, F2] }],
      verifiedOwnedFactIds: new Set([F1, F2]),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lines).toEqual([{ text: "Built it", fact_ids: [F1, F2] }]);
  });

  it("rejects the whole payload when ANY line cites a non-member (all-or-nothing)", () => {
    const r = reconcileResumeCitations({
      lines: [
        { text: "Good line", fact_ids: [F1] },
        { text: "Bad line", fact_ids: [FOREIGN_FACT] },
      ],
      verifiedOwnedFactIds: new Set([F1]),
    });
    expect(r.ok).toBe(false);
  });

  // preview == save: generateResume validates the model output then reconciles it against the user's
  // verified+owned facts before showing the preview — so a hallucinated (UUID-shaped but not-owned or
  // unverified) fact id is rejected at the review surface, exactly as persistResume rejects it at save.
  it("preview==save: rejects a UUID-shaped fact id that is not among the verified-owned facts", () => {
    const generated = { lines: [{ text: "Led the rewrite", fact_ids: [FOREIGN_FACT] }] };
    const validated = validateResume(generated);
    expect(validated.ok).toBe(true); // structurally fine — the bug is realness, caught next
    if (!validated.ok) return;
    const r = reconcileResumeCitations({
      lines: validated.value.lines,
      verifiedOwnedFactIds: new Set([F1]), // the user's verified facts; FOREIGN_FACT is NOT among them
    });
    expect(r.ok).toBe(false);
  });
});
