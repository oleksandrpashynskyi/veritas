// The résumé contract + fail-closed validators. PURE — no SDK, no `server-only` — so it is
// unit-testable (resume-schema.test.ts) and reusable on both sides of the boundary: it runs on the
// generator's structured output in generation.ts AND again on the client-submitted accepted-subset
// in the saveResume path (persistResume). "Trust the parse, not the prose" (AGENTS.md / M3 plan).
//
// Two layers, deliberately split (mirrors coverage-schema.ts):
//   validateResume          — STRUCTURAL + banned-word: shape, non-empty text, UUID-shaped ids, the
//                             cited-check (a line MUST cite >=1 fact), the banned-word check, caps.
//                             Knows nothing about which ids are real. Pure over an UNKNOWN value.
//   reconcileResumeCitations — PROVENANCE: every cited fact_id is one the user OWNS and has VERIFIED.
//                             Pure over already-validated lines + the real id set (which the caller
//                             builds from the per-user/RLS client with `.eq("verified", true)`).
// Realness/ownership/VERIFIED is therefore proven against the DB by persistResume + verify-m5, not
// here. The banned-word list itself lives in src/lib/provenance/banned.ts (its single home).
import { findBannedWords } from "../provenance/banned";

export type ResumeLine = { text: string; fact_ids: string[] };

export type Resume = { lines: ResumeLine[] };

export type ResumeResult =
  | { ok: true; value: Resume }
  | { ok: false; error: string };

export type ResumeReconcileResult =
  | { ok: true; lines: ResumeLine[] }
  | { ok: false; error: string };

// Sanity caps — a single generated résumé should never legitimately exceed these. A response past
// them signals a runaway generation, not a real document; exceeding => fail closed.
const MAX_LINES = 60;
const MAX_FACT_IDS_PER_LINE = 20;

// Postgres gen_random_uuid() output. Anything else (a placeholder like "fact-1", an index, a name) is
// not a real id and is rejected structurally — before it can reach the DB or the ownership check.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// JSON Schema for Anthropic Structured Outputs. Guarantees the SHAPE (object with a `lines` array of
// {text, fact_ids}); the validator enforces what the schema can't express (non-empty text, the
// cited-check, UUID shape, banned words, caps) and fails closed if a refusal / max_tokens stop yields
// off-shape output.
export const RESUME_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["lines"],
  properties: {
    lines: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "fact_ids"],
        properties: {
          text: { type: "string" },
          fact_ids: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Validate an UNKNOWN value (parsed generator JSON, or a client-submitted accepted-subset) into a
// clean Resume. Rejects the WHOLE thing on any malformed/off-shape/uncited/banned-word part — never
// returns partial structure. Normalizes on success (trims text, de-dupes fact_ids, drops unexpected
// line properties). An empty `lines` array is structurally valid here; refusing to store an empty
// document is persistResume's business rule, not the pure validator's.
export function validateResume(raw: unknown): ResumeResult {
  if (!isPlainObject(raw)) {
    return { ok: false, error: "resume payload is not an object" };
  }
  const list = raw.lines;
  if (!Array.isArray(list)) {
    return { ok: false, error: "lines must be an array" };
  }
  if (list.length > MAX_LINES) {
    return { ok: false, error: `too many resume lines (> ${MAX_LINES})` };
  }

  const lines: ResumeLine[] = [];

  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!isPlainObject(e)) {
      return { ok: false, error: `line ${i} is not an object` };
    }
    if (typeof e.text !== "string") {
      return { ok: false, error: `line ${i} text is not a string` };
    }
    const text = e.text.trim();
    if (text.length === 0) {
      return { ok: false, error: `line ${i} text is empty` };
    }
    if (!Array.isArray(e.fact_ids)) {
      return { ok: false, error: `line ${i} fact_ids must be an array` };
    }
    // The cited-check — the structural half of the provenance invariant. A line that cites nothing
    // must never exist (mirrors the DB CHECK doc_line_fact_ids_not_empty), rejected before any store.
    if (e.fact_ids.length === 0) {
      return { ok: false, error: `line ${i} cites no facts` };
    }
    if (e.fact_ids.length > MAX_FACT_IDS_PER_LINE) {
      return { ok: false, error: `line ${i} cites too many facts (> ${MAX_FACT_IDS_PER_LINE})` };
    }

    const factIds: string[] = [];
    const seenFact = new Set<string>();
    for (const fid of e.fact_ids) {
      if (typeof fid !== "string" || !UUID_RE.test(fid)) {
        return { ok: false, error: `line ${i} fact_ids contains a non-uuid value` };
      }
      if (!seenFact.has(fid)) {
        seenFact.add(fid);
        factIds.push(fid);
      }
    }

    // The banned-word check — refusing the homogenised buzzword vocabulary at the validation layer,
    // never merely asked-against in the prompt. Whole-word, case-insensitive (see banned.ts).
    const banned = findBannedWords(text);
    if (banned.length > 0) {
      return { ok: false, error: `line ${i} contains banned wording: ${banned.join(", ")}` };
    }

    lines.push({ text, fact_ids: factIds });
  }

  return { ok: true, value: { lines } };
}

// The provenance reconciler. `verifiedOwnedFactIds` is the user's REAL data, fetched by the caller
// through the per-user (RLS) client with `.eq("verified", true)` — so an id the user does not own, or
// owns but has not verified, is simply absent. Fails closed (rejects the WHOLE payload) if any line
// cites a fact outside that set: this single membership check closes realness + ownership + the
// VERIFIED-only rule at once. The DB trigger checks existence but NOT verification — this is the gate
// that enforces "the résumé cites verified facts only".
export function reconcileResumeCitations(args: {
  lines: ResumeLine[];
  verifiedOwnedFactIds: Set<string>;
}): ResumeReconcileResult {
  const { lines, verifiedOwnedFactIds } = args;

  for (const line of lines) {
    for (const fid of line.fact_ids) {
      if (!verifiedOwnedFactIds.has(fid)) {
        return { ok: false, error: `fact ${fid} is not an owned, verified fact` };
      }
    }
  }

  return { ok: true, lines };
}
