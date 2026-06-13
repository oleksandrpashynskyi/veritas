import { describe, expect, it } from "vitest";
import { findBannedWords } from "./banned";

describe("findBannedWords", () => {
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

  it("respects word boundaries (no substring false positives)", () => {
    // "leverages" must NOT trip the "leverage" entry — inflections are listed
    // explicitly, never substring-matched.
    expect(findBannedWords("The system leverages caching")).toEqual([]);
  });

  it("deduplicates and preserves list order across multiple hits", () => {
    expect(
      findBannedWords("A passionate, dynamic, passionate rockstar"),
    ).toEqual(["dynamic", "passionate", "rockstar"]);
  });
});
