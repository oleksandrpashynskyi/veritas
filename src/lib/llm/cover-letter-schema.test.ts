import { describe, expect, it } from "vitest";
import {
  ALLOWED_CONNECTIVE_ROLES,
  findExperientialLanguage,
  validateCoverLetter,
} from "./cover-letter-schema";

// Valid v4-shaped UUIDs for the fixtures. validateCoverLetter routes claim blocks through the SAME
// validateClaimLines used by the résumé (resume-schema.ts), so the cited-check / UUID / banned-word /
// dedup behaviour is already proven by resume-schema.test.ts; here we focus on the cover-letter
// SPECIFICS: the claim/connective split, the connective structural rule (no citations, allow-listed
// role), the shared position space, and the experiential-language advisory.
const F1 = "11111111-1111-4111-8111-111111111111";
const F2 = "22222222-2222-4222-8222-222222222222";

const claim = (text: string, fact_ids: string[], role = "") => ({
  kind: "claim",
  text,
  fact_ids,
  role,
});
const conn = (role: string, text: string, fact_ids: string[] = []) => ({
  kind: "connective",
  text,
  role,
  fact_ids,
});

describe("validateCoverLetter", () => {
  it("accepts a well-formed letter and splits claims from connective with a shared position space", () => {
    const raw = {
      blocks: [
        conn("greeting", "Dear Hiring Manager,"),
        conn("interest", "I'm writing regarding the ML Engineer role."),
        claim("Built the billing system serving 2M users", [F1]),
        conn("closing", "I'd welcome the chance to talk."),
      ],
    };
    const r = validateCoverLetter(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Claim lines carry their position in the ORIGINAL block sequence (index 2 here).
    expect(r.claimLines).toEqual([
      { text: "Built the billing system serving 2M users", fact_ids: [F1], position: 2 },
    ]);
    // Connective segments carry role + their positions (0, 1, 3) in the same shared space.
    expect(r.connective).toEqual([
      { role: "greeting", text: "Dear Hiring Manager,", position: 0 },
      { role: "interest", text: "I'm writing regarding the ML Engineer role.", position: 1 },
      { role: "closing", text: "I'd welcome the chance to talk.", position: 3 },
    ]);
  });

  it("rejects a non-object payload", () => {
    expect(validateCoverLetter(null).ok).toBe(false);
    expect(validateCoverLetter("x").ok).toBe(false);
  });

  it("rejects a missing/non-array blocks field", () => {
    expect(validateCoverLetter({}).ok).toBe(false);
    expect(validateCoverLetter({ blocks: "x" }).ok).toBe(false);
  });

  it("rejects a block that is not an object", () => {
    expect(validateCoverLetter({ blocks: ["x"] }).ok).toBe(false);
  });

  it("rejects a block with an unknown kind", () => {
    expect(
      validateCoverLetter({ blocks: [{ kind: "footer", text: "x", fact_ids: [], role: "" }] }).ok,
    ).toBe(false);
  });

  // ── claim blocks route through the shared validateClaimLines ──────────────────────────────
  it("rejects a claim block that cites no facts (the cited-check)", () => {
    expect(validateCoverLetter({ blocks: [claim("Did real work", [])] }).ok).toBe(false);
  });

  it("rejects a claim block citing a non-uuid value", () => {
    expect(validateCoverLetter({ blocks: [claim("Did real work", ["fact-1"])] }).ok).toBe(false);
  });

  it("rejects a claim block containing a hard-blocked word", () => {
    expect(
      validateCoverLetter({ blocks: [claim("Spearheaded the migration", [F1])] }).ok,
    ).toBe(false);
  });

  it("de-duplicates a claim's fact_ids and trims its text", () => {
    const r = validateCoverLetter({ blocks: [claim("  Built it  ", [F1, F1, F2])] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.claimLines[0]).toEqual({ text: "Built it", fact_ids: [F1, F2], position: 0 });
  });

  // ── connective blocks: the structural rule ────────────────────────────────────────────────
  it("rejects a connective block whose role is not allow-listed", () => {
    expect(validateCoverLetter({ blocks: [conn("postscript", "By the way…")] }).ok).toBe(false);
  });

  it("REJECTS a connective block that carries any fact_ids (a citation can never hide in framing)", () => {
    // The load-bearing structural rule: connective prose has no citation slot, so a connective block
    // that smuggles a fact_id is rejected outright — it can never be stored as a claim.
    expect(
      validateCoverLetter({ blocks: [conn("fit", "Your mission resonates", [F1])] }).ok,
    ).toBe(false);
  });

  it("rejects a connective block with empty/whitespace text", () => {
    expect(validateCoverLetter({ blocks: [conn("greeting", "   ")] }).ok).toBe(false);
  });

  it("rejects a connective block containing a hard-blocked word (banned words apply to prose too)", () => {
    expect(
      validateCoverLetter({ blocks: [conn("interest", "I am passionate about this role")] }).ok,
    ).toBe(false);
  });

  it("trims connective text and preserves the allow-listed role", () => {
    const r = validateCoverLetter({ blocks: [conn("signoff", "  Sincerely,  ")] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.connective[0]).toEqual({ role: "signoff", text: "Sincerely,", position: 0 });
  });

  it("accepts a letter with zero claim blocks (the empty-document rejection is the gate's job)", () => {
    // Mirrors validateResume: an empty claim set is structurally valid here; persistDocument refuses
    // to store a document with no cited claim line.
    const r = validateCoverLetter({ blocks: [conn("greeting", "Dear Hiring Manager,")] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.claimLines).toEqual([]);
  });

  it("rejects an absurd number of blocks (runaway generation)", () => {
    const blocks = Array.from({ length: 500 }, () => claim("x", [F1]));
    expect(validateCoverLetter({ blocks }).ok).toBe(false);
  });

  it("rejects a connective segment that is absurdly long", () => {
    expect(validateCoverLetter({ blocks: [conn("interest", "a".repeat(5000))] }).ok).toBe(false);
  });

  it("exposes the allow-listed connective roles", () => {
    expect(ALLOWED_CONNECTIVE_ROLES).toContain("greeting");
    expect(ALLOWED_CONNECTIVE_ROLES).toContain("closing");
  });
});

describe("findExperientialLanguage (advisory only — never a rejection)", () => {
  it("returns nothing for pure sentiment that asserts no experience", () => {
    expect(findExperientialLanguage("Your mission resonates with me")).toEqual([]);
    expect(findExperientialLanguage("I'm excited about the ML Engineer role")).toEqual([]);
  });

  it("flags an experiential claim smuggled into framing", () => {
    // The milestone's central danger — a claim wearing fit-framing clothes.
    const hits = findExperientialLanguage(
      "Your mission resonates with me, having shipped production ML systems for years",
    );
    expect(hits.length).toBeGreaterThan(0);
  });

  it("flags a first-person experiential verb", () => {
    expect(findExperientialLanguage("I led a team of ten").length).toBeGreaterThan(0);
    expect(findExperientialLanguage("I built the platform").length).toBeGreaterThan(0);
  });

  it("flags a years-of-experience phrase", () => {
    expect(findExperientialLanguage("I have 10+ years of experience").length).toBeGreaterThan(0);
  });
});
