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

  it("matches a banned entry only as a whole word, not inside a longer word", () => {
    // "wizard" is banned but must not trip inside "wizardry".
    expect(findBannedWords("Their wizardry impressed the team")).toEqual([]);
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
    expect(
      findBannedWords("A passionate, dynamic, passionate rockstar"),
    ).toEqual(["dynamic", "passionate", "rockstar"]);
  });
});
