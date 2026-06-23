/**
 * Corporate-cliché vocabulary, split into two tiers.
 *
 * PROJECT_PLAN §2 "No resume soup": the homogenised buzzword vocabulary that makes every AI resume
 * sound identical is rejected at the validation layer — not asked-against in a prompt. BUT (AGENTS.md):
 * "The banned-words list must never reject a truthful, sourced line. Ambiguous words (those with
 * legitimate technical meaning, e.g. 'dynamic') should warn, not hard-block — refusing to forbid the
 * truth takes priority over catching every cliché." So the list is two tiers:
 *
 *   HARD_BLOCKED_WORDS — unambiguous résumé fluff. A match is a FATAL validation rejection
 *                        (validateResume rejects the line). findBannedWords() reports these.
 *   WARN_WORDS         — words with a legitimate technical meaning ("dynamic programming", a setup
 *                        "wizard"). ADVISORY only — never fatal, so a truthful sourced line is never
 *                        rejected for using one. findWarnWords() reports these (for optional UI surfacing).
 *
 * Entries are lowercase. Multi-word entries match across either spaces or hyphens ("game changer" also
 * catches "game-changer"). Matching is whole-word — a banned entry never trips inside a longer word
 * ("wizard" does not match "wizardry"). Inflections are listed explicitly rather than stemmed.
 */
export const HARD_BLOCKED_WORDS: readonly string[] = [
  "spearheaded",
  "spearheading",
  "spearheads",
  "spearhead",
  "leveraged",
  "leveraging",
  "leverages",
  "leverage",
  "synergize",
  "synergy",
  "results driven",
  "results oriented",
  "detail oriented",
  "self starter",
  "go getter",
  "team player",
  "thought leader",
  "proven track record",
  "passionate",
  "guru",
  "ninja",
  "rockstar",
  "visionary",
  "game changer",
  "cutting edge",
  "world class",
  "best in class",
  "move the needle",
  "low hanging fruit",
  "win win",
  "paradigm shift",
  "utilize",
  "utilizing",
  "utilizes",
  "utilized",
  "impactful",
] as const;

// Ambiguous technical words — a legitimate, truthful résumé line can contain these ("dynamic
// programming optimization", "built a configuration wizard"). Advisory only; never a fatal rejection.
export const WARN_WORDS: readonly string[] = ["dynamic", "wizard"] as const;

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * "results driven" -> /(?<![\w-])results[\s-]+driven(?![\w-])/i
 * The lookbehind/lookahead enforce whole-word boundaries that also treat hyphens
 * as part of a word, so "self-starter" is caught but "selfless" is not.
 */
function toPattern(phrase: string): RegExp {
  const parts = phrase.split(/[\s-]+/).map(escapeRegExp);
  return new RegExp(`(?<![\\w-])${parts.join("[\\s-]+")}(?![\\w-])`, "i");
}

const HARD_PATTERNS: ReadonlyArray<readonly [string, RegExp]> =
  HARD_BLOCKED_WORDS.map((word) => [word, toPattern(word)] as const);

const WARN_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = WARN_WORDS.map(
  (word) => [word, toPattern(word)] as const,
);

/**
 * Returns the HARD-BLOCKED entries found in `text`, deduplicated and in list order. A non-empty
 * result is a FATAL validation rejection. An empty array means the text is clean of hard-blocked fluff.
 */
export function findBannedWords(text: string): string[] {
  return HARD_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(
    ([word]) => word,
  );
}

/**
 * Returns the WARN-only (ambiguous technical) entries found in `text`. ADVISORY only — never a
 * validation rejection. Surfaced so the user can judge; refusing to forbid the truth beats catching
 * every cliché.
 */
export function findWarnWords(text: string): string[] {
  return WARN_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(
    ([word]) => word,
  );
}
