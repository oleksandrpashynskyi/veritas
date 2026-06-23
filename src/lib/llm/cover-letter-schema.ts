// The cover-letter contract + fail-closed validators. PURE — no SDK, no `server-only` — so it is
// unit-testable (cover-letter-schema.test.ts) and reusable on both sides of the boundary: it runs on
// the generator's structured output in cover-letter-generation.ts AND again on the client-submitted
// accepted-subset at save time (persistCoverLetter -> persistDocument). "Trust the parse, not the
// prose" (AGENTS.md / M3 plan), exactly as the résumé's resume-schema.ts.
//
// A cover letter is an ordered list of BLOCKS, each a `claim` or a `connective`:
//   * CLAIM blocks are experiential assertions — what the candidate has done/built/led/knows. They
//     run through the SAME validateClaimLines as a résumé bullet (cited-check, banned words, UUID,
//     dedup, caps), and every one must cite ≥1 fact. Realness/ownership/verified is reconciled against
//     the DB by persistDocument, not here.
//   * CONNECTIVE blocks are framing prose that assert NO experiential fact (greeting / statement of
//     interest / fit / closing courtesy / sign-off). The STRUCTURAL RULE enforced here: a connective
//     block has an allow-listed role and carries NO citation — a connective that smuggles a fact_id is
//     rejected outright, so a claim can never hide in framing and a connective can never be stored as
//     a claim. The "no experiential assertion" SEMANTICS are not machine-decidable; they are held by
//     the conservative prompt + the user's per-line approval, aided by the findExperientialLanguage
//     advisory below (a warn, never a rejection — "refusing to forbid the truth" beats false blocks).
import { isPlainObject, validateClaimLines } from "./resume-schema";
import { findBannedWords } from "../provenance/banned";
import type {
  ClaimLineForStore,
  ConnectiveSegment,
  DocValidated,
} from "../provenance/document";

// The framing a letter genuinely needs — and nothing that asserts experience. `body_intro` is a
// topic/transition sentence that introduces a paragraph without claiming anything.
export const ALLOWED_CONNECTIVE_ROLES: readonly string[] = [
  "greeting",
  "interest",
  "fit",
  "body_intro",
  "closing",
  "signoff",
] as const;

// Sanity caps — a single generated cover letter should never legitimately exceed these. A letter is
// shorter than a résumé: a handful of cited claims woven with framing. Exceeding => fail closed.
const MAX_BLOCKS = 40;
const MAX_CLAIM_LINES = 25;
const MAX_CONNECTIVE = 15;
const MAX_CONNECTIVE_LEN = 1000;

// JSON Schema for Anthropic Structured Outputs. Guarantees the SHAPE (an array of blocks, each with a
// kind/text/fact_ids/role); the validator enforces what the schema can't express (the cited-check on
// claims, the connective structural rule + role allow-list, banned words, caps) and fails closed if a
// refusal / max_tokens stop yields off-shape output.
export const COVER_LETTER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["blocks"],
  properties: {
    blocks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "text", "fact_ids", "role"],
        properties: {
          kind: { type: "string", enum: ["claim", "connective"] },
          text: { type: "string" },
          fact_ids: { type: "array", items: { type: "string" } },
          role: { type: "string" },
        },
      },
    },
  },
};

type ConnectiveResult =
  | { ok: true; value: ConnectiveSegment }
  | { ok: false; error: string };

// Validate ONE connective block at its position `i`. The structural rule lives here: allow-listed
// role, non-empty/bounded text, NO citation, no banned wording. A connective has no fact_ids slot in
// storage — this is the gate that keeps it that way.
function validateConnectiveBlock(b: Record<string, unknown>, i: number): ConnectiveResult {
  if (typeof b.role !== "string" || !ALLOWED_CONNECTIVE_ROLES.includes(b.role)) {
    return { ok: false, error: `connective block ${i} has a disallowed role` };
  }
  if (typeof b.text !== "string") {
    return { ok: false, error: `connective block ${i} text is not a string` };
  }
  const text = b.text.trim();
  if (text.length === 0) {
    return { ok: false, error: `connective block ${i} text is empty` };
  }
  if (text.length > MAX_CONNECTIVE_LEN) {
    return { ok: false, error: `connective block ${i} text is too long (> ${MAX_CONNECTIVE_LEN})` };
  }
  // THE structural rule: connective prose carries no citation. A connective block with any fact_id is
  // rejected — it can never be stored as a claim, and a claim can never masquerade as framing.
  const fids = b.fact_ids;
  const carriesCitation = Array.isArray(fids) ? fids.length > 0 : fids != null;
  if (carriesCitation) {
    return { ok: false, error: `connective block ${i} must not cite facts` };
  }
  // Banned-word check — the hard-blocked buzzword vocabulary is refused in generated prose too.
  const banned = findBannedWords(text);
  if (banned.length > 0) {
    return { ok: false, error: `connective block ${i} contains banned wording: ${banned.join(", ")}` };
  }
  return { ok: true, value: { role: b.role, text, position: i } };
}

// Validate an UNKNOWN value (parsed generator JSON, or a client-submitted accepted-subset) into the
// split form the shared gate consumes: cited CLAIM lines + CONNECTIVE segments, both carrying their
// position in the original ordered block sequence (a single shared space, so display is one sort).
// Rejects the WHOLE payload on any malformed/off-shape/uncited/banned/smuggled-citation part. An empty
// claim set is structurally valid here; refusing the empty document is persistDocument's business rule.
export function validateCoverLetter(raw: unknown): DocValidated {
  if (!isPlainObject(raw)) {
    return { ok: false, error: "cover letter payload is not an object" };
  }
  const blocks = raw.blocks;
  if (!Array.isArray(blocks)) {
    return { ok: false, error: "blocks must be an array" };
  }
  if (blocks.length > MAX_BLOCKS) {
    return { ok: false, error: `too many cover letter blocks (> ${MAX_BLOCKS})` };
  }

  // First pass: split by kind. Validate each connective inline; collect claim blocks (untouched) plus
  // their positions for the shared validateClaimLines. validateClaimLines reads text + fact_ids and
  // ignores the block's `kind`/`role`, so a claim block can be passed straight through.
  const claimBlocks: unknown[] = [];
  const claimPositions: number[] = [];
  const connective: ConnectiveSegment[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!isPlainObject(b)) {
      return { ok: false, error: `block ${i} is not an object` };
    }
    if (b.kind === "claim") {
      claimBlocks.push(b);
      claimPositions.push(i);
    } else if (b.kind === "connective") {
      const seg = validateConnectiveBlock(b, i);
      if (!seg.ok) return { ok: false, error: seg.error };
      connective.push(seg.value);
      if (connective.length > MAX_CONNECTIVE) {
        return { ok: false, error: `too many connective blocks (> ${MAX_CONNECTIVE})` };
      }
    } else {
      return { ok: false, error: `block ${i} has an unknown kind` };
    }
  }

  // Claim blocks: the SAME cited-check / banned-word / UUID / dedup / caps logic as a résumé bullet.
  const claimRes = validateClaimLines(claimBlocks, {
    noun: "cover letter",
    maxLines: MAX_CLAIM_LINES,
  });
  if (!claimRes.ok) return { ok: false, error: claimRes.error };

  // Re-attach each claim line's position in the original block sequence (shared with connective).
  const claimLines: ClaimLineForStore[] = claimRes.lines.map((line, k) => ({
    ...line,
    position: claimPositions[k],
  }));

  return { ok: true, claimLines, connective };
}

// ── The experiential-language advisory ────────────────────────────────────────────────────────────
// Heuristic markers of experiential language. ADVISORY ONLY — never a validation rejection. Surfaced
// on connective blocks at approval-time so the reviewer's eye lands on a possible smuggled claim ("…
// having shipped production ML systems"). Refusing to forbid the truth beats catching every cliché, so
// this never blocks: a connective that trips a flag is still reviewable and acceptable.
const EXPERIENTIAL_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  [
    "first-person experience",
    /\b(i|we)\s+(built|led|ship|shipped|develop|developed|design|designed|architect|architected|create|created|manage|managed|deliver|delivered|implement|implemented|engineer|engineered|found|founded|launch|launched|scale|scaled|drove|drive|ran|run|own|owned|wrote|written|made)\b/i,
  ],
  [
    "having + done",
    /\bhaving\s+(built|led|shipped|developed|designed|architected|created|managed|delivered|implemented|engineered|founded|launched|scaled|worked|run|written|made|spent)\b/i,
  ],
  ["years of experience", /\b\d+\+?\s+years?\b/i],
  ["years of experience", /\byears\s+of\s+(experience|expertise)\b/i],
  ["my experience", /\bmy\s+(experience|background|career|expertise)\b/i],
];

export function findExperientialLanguage(text: string): string[] {
  const hits: string[] = [];
  for (const [label, pattern] of EXPERIENTIAL_PATTERNS) {
    if (pattern.test(text) && !hits.includes(label)) {
      hits.push(label);
    }
  }
  return hits;
}
