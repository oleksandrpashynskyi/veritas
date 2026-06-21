import { describe, expect, it } from "vitest";
import { validateExtraction } from "./extraction-schema";

// The validator is the "trust the parse, not the prose" boundary (AGENTS.md / M3 plan): it runs
// on the model's structured output AND again on the client-submitted preview payload at save time.
// It must FAIL CLOSED — any malformed, missing, or off-shape structure is rejected, never stored.
describe("validateExtraction", () => {
  const valid = {
    company: "Acme Corp",
    title: "Senior Engineer",
    requirements: [
      { text: "5+ years TypeScript", kind: "must" },
      { text: "GraphQL experience", kind: "nice" },
    ],
  };

  it("accepts a well-formed extraction and returns the normalized value", () => {
    const r = validateExtraction(valid);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({
        company: "Acme Corp",
        title: "Senior Engineer",
        requirements: [
          { text: "5+ years TypeScript", kind: "must" },
          { text: "GraphQL experience", kind: "nice" },
        ],
      });
    }
  });

  it("trims text and company/title, coercing empty strings to null", () => {
    const r = validateExtraction({
      company: "   ",
      title: "  Acme  ",
      requirements: [{ text: "  Build things  ", kind: "responsibility" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.company).toBeNull();
      expect(r.value.title).toBe("Acme");
      expect(r.value.requirements[0].text).toBe("Build things");
    }
  });

  it("treats a missing company/title as null", () => {
    const r = validateExtraction({
      requirements: [{ text: "a", kind: "must" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.company).toBeNull();
      expect(r.value.title).toBeNull();
    }
  });

  it("allows an empty requirements array (surfaced in the UI, not stored silently)", () => {
    const r = validateExtraction({ company: null, title: null, requirements: [] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.requirements).toEqual([]);
  });

  it("accepts all four requirement kinds", () => {
    const r = validateExtraction({
      company: null,
      title: null,
      requirements: [
        { text: "a", kind: "must" },
        { text: "b", kind: "nice" },
        { text: "c", kind: "responsibility" },
        { text: "d", kind: "keyword" },
      ],
    });
    expect(r.ok).toBe(true);
  });

  it("drops unexpected properties on a requirement (normalizes to text + kind only)", () => {
    const r = validateExtraction({
      company: null,
      title: null,
      requirements: [{ text: "a", kind: "must", injected: "DROP ME" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.requirements[0]).toEqual({ text: "a", kind: "must" });
  });

  it("rejects a null root", () => {
    expect(validateExtraction(null).ok).toBe(false);
  });

  it("rejects a non-object root (array)", () => {
    expect(validateExtraction([]).ok).toBe(false);
  });

  it("rejects when requirements is missing", () => {
    expect(validateExtraction({ company: null, title: null }).ok).toBe(false);
  });

  it("rejects when requirements is not an array", () => {
    expect(
      validateExtraction({ company: null, title: null, requirements: "x" }).ok,
    ).toBe(false);
  });

  it("rejects a requirement that is not an object", () => {
    expect(
      validateExtraction({ company: null, title: null, requirements: ["x"] }).ok,
    ).toBe(false);
  });

  it("rejects a requirement missing text", () => {
    expect(
      validateExtraction({
        company: null,
        title: null,
        requirements: [{ kind: "must" }],
      }).ok,
    ).toBe(false);
  });

  it("rejects a requirement with empty/whitespace text", () => {
    expect(
      validateExtraction({
        company: null,
        title: null,
        requirements: [{ text: "   ", kind: "must" }],
      }).ok,
    ).toBe(false);
  });

  it("rejects a requirement with non-string text", () => {
    expect(
      validateExtraction({
        company: null,
        title: null,
        requirements: [{ text: 5, kind: "must" }],
      }).ok,
    ).toBe(false);
  });

  it("rejects a requirement with an unknown kind", () => {
    expect(
      validateExtraction({
        company: null,
        title: null,
        requirements: [{ text: "a", kind: "skill" }],
      }).ok,
    ).toBe(false);
  });

  it("rejects a requirement missing kind", () => {
    expect(
      validateExtraction({
        company: null,
        title: null,
        requirements: [{ text: "a" }],
      }).ok,
    ).toBe(false);
  });

  it("rejects a non-string, non-null company", () => {
    expect(
      validateExtraction({ company: 5, title: null, requirements: [] }).ok,
    ).toBe(false);
  });

  it("rejects an absurdly long requirements list", () => {
    const many = Array.from({ length: 201 }, () => ({ text: "a", kind: "must" }));
    expect(
      validateExtraction({ company: null, title: null, requirements: many }).ok,
    ).toBe(false);
  });

  it("rejects a requirement whose text exceeds the length cap", () => {
    const long = "a".repeat(2001);
    expect(
      validateExtraction({
        company: null,
        title: null,
        requirements: [{ text: long, kind: "must" }],
      }).ok,
    ).toBe(false);
  });
});
