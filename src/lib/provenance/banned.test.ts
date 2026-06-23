import { describe, expect, it } from "vitest";
import { findBannedWords, findWarnWords } from "./banned";

// findBannedWords = the HARD-BLOCKED set (unambiguous résumé fluff). A non-empty result is a FATAL
// validation rejection (validateResume rejects the line). Ambiguous technical words are NOT here.
describe("findBannedWords (hard-blocked — fatal)", () => {
  it("returns an empty array for clean text", () => {
    expect(
      findBannedWords("Built the billing service and cut p95 latency by 40%."),
    ).toEqual([]);
  });

  it("matches case-insensitively", () => {
    expect(findBannedWords("Spearheaded the migration")).toEqual(["spearheaded"]);
  });

  it("matches a multi-word phrase across a hyphen", () => {
    // "results-driven" must be caught by the "results driven" entry.
    expect(findBannedWords("A results-driven engineer")).toEqual([
      "results driven",
    ]);
  });

  it("catches common action-verb inflections of banned roots", () => {
    // The list includes leveraging/leverages, utilizing/utilizes,
    // spearheading/spearheads — not just the base/past forms.
    expect(findBannedWords("Leveraging and utilizing the pipeline")).toEqual([
      "leveraging",
      "utilizing",
    ]);
  });

  it("deduplicates and preserves list order across multiple hits", () => {
    // 'dynamic' is now warn-only (ambiguous technical), so it is absent from this hard-block result.
    expect(
      findBannedWords("A passionate, passionate rockstar"),
    ).toEqual(["passionate", "rockstar"]);
  });

  it("does NOT hard-block ambiguous technical words (dynamic, wizard)", () => {
    // The whole point of the split: a truthful, sourced line using a real technical term must pass.
    expect(findBannedWords("Built a dynamic, configurable setup wizard")).toEqual([]);
  });
});

// findWarnWords = the WARN-only set (words with legitimate technical meaning, per AGENTS.md, e.g.
// 'dynamic'). Advisory ONLY — never fatal — so it can never reject a truthful, sourced line.
describe("findWarnWords (advisory — never fatal)", () => {
  it("returns an empty array for clean text", () => {
    expect(findWarnWords("Built the billing service")).toEqual([]);
  });

  it("flags an ambiguous technical word (dynamic)", () => {
    expect(findWarnWords("dynamic programming optimization")).toEqual(["dynamic"]);
  });

  it("flags 'wizard' but only as a whole word (not inside 'wizardry')", () => {
    expect(findWarnWords("Built a setup wizard")).toEqual(["wizard"]);
    expect(findWarnWords("Their wizardry impressed the team")).toEqual([]);
  });

  it("does not flag hard-blocked fluff", () => {
    expect(findWarnWords("Spearheaded the migration")).toEqual([]);
  });
});
