/**
 * Corporate-cliché words and phrases that fail validation.
 *
 * PROJECT_PLAN §2 "No resume soup": output is generated in the user's voice, and
 * the homogenised buzzword vocabulary that makes every AI resume sound identical
 * is rejected at the validation layer — not asked-against in a prompt.
 *
 * Entries are lowercase. Multi-word entries match across either spaces or hyphens
 * ("game changer" also catches "game-changer"). Matching is whole-word — a banned
 * entry never trips inside a longer word ("wizard" does not match "wizardry").
 * Inflections are listed explicitly rather than stemmed; the common action-verb
 * forms (leverage/leveraging/leverages, utilize/utilizing/utilizes,
 * spearhead/spearheading/spearheads) are all included so obvious variants of a
 * banned root don't slip through.
 */
export const BANNED_WORDS: readonly string[] = [
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
  "dynamic",
  "passionate",
  "guru",
  "ninja",
  "rockstar",
  "wizard",
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

const PATTERNS: ReadonlyArray<readonly [string, RegExp]> = BANNED_WORDS.map(
  (word) => [word, toPattern(word)] as const,
);

/**
 * Returns the banned entries found in `text`, deduplicated and in list order.
 * An empty array means the text is clean.
 */
export function findBannedWords(text: string): string[] {
  return PATTERNS.filter(([, pattern]) => pattern.test(text)).map(
    ([word]) => word,
  );
}
