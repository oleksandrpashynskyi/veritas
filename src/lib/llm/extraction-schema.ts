// The extraction contract + fail-closed validator. PURE — no SDK, no `server-only` — so it is
// unit-testable (extraction-schema.test.ts) and reusable on both sides of the boundary: it runs on
// the model's structured output in extraction.ts AND again on the client-submitted preview payload
// in the saveJob server action. "Trust the parse, not the prose" (AGENTS.md / M3 plan).
//
// This is also the single source of truth for the requirement vocabulary; the /jobs UI imports
// REQUIREMENT_KINDS / RequirementKind from here rather than redefining them.

export const REQUIREMENT_KINDS = [
  "must",
  "nice",
  "responsibility",
  "keyword",
] as const;

export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];

export type Requirement = { text: string; kind: RequirementKind };

export type Extraction = {
  company: string | null;
  title: string | null;
  requirements: Requirement[];
};

export type ExtractionResult =
  | { ok: true; value: Extraction }
  | { ok: false; error: string };

// Sanity caps — a single billed extraction should never legitimately produce more than this.
// Exceeding them signals a malformed / runaway response, so we fail closed rather than store it.
const MAX_REQUIREMENTS = 200;
const MAX_TEXT_LEN = 2000;

// JSON Schema for Anthropic Structured Outputs. company/title are plain strings (the model emits
// "" when unknown — the validator coerces empty -> null), avoiding nullable-type schema quirks.
// Structured Outputs guarantees this SHAPE; the validator enforces what the schema can't express
// (non-empty text, the length/count caps) and fails closed if a refusal / max_tokens stop yields
// off-shape output.
export const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["company", "title", "requirements"],
  properties: {
    company: { type: "string" },
    title: { type: "string" },
    requirements: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "kind"],
        properties: {
          text: { type: "string" },
          kind: { type: "string", enum: [...REQUIREMENT_KINDS] },
        },
      },
    },
  },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Optional metadata (company/title): a string or null/absent. Trimmed; empty -> null. A wrong type
// (number/object/…) is a hard reject — malformed structure, not a missing value.
function normalizeMeta(
  v: unknown,
): { ok: true; value: string | null } | { ok: false } {
  if (v === null || v === undefined) return { ok: true, value: null };
  if (typeof v !== "string") return { ok: false };
  const s = v.trim();
  return { ok: true, value: s === "" ? null : s };
}

// Validate an UNKNOWN value (parsed model JSON, or a client-submitted preview payload) into a clean
// Extraction. Rejects the WHOLE thing on any malformed/missing/off-shape part — never returns
// partial hallucinated structure. Normalizes on success (trims text, coerces empty meta -> null,
// drops unexpected requirement properties).
export function validateExtraction(raw: unknown): ExtractionResult {
  if (!isPlainObject(raw)) {
    return { ok: false, error: "extraction is not an object" };
  }

  const company = normalizeMeta(raw.company);
  if (!company.ok) return { ok: false, error: "company must be a string or null" };
  const title = normalizeMeta(raw.title);
  if (!title.ok) return { ok: false, error: "title must be a string or null" };

  const reqs = raw.requirements;
  if (!Array.isArray(reqs)) {
    return { ok: false, error: "requirements must be an array" };
  }
  if (reqs.length > MAX_REQUIREMENTS) {
    return { ok: false, error: `too many requirements (> ${MAX_REQUIREMENTS})` };
  }

  const requirements: Requirement[] = [];
  for (let i = 0; i < reqs.length; i++) {
    const r = reqs[i];
    if (!isPlainObject(r)) {
      return { ok: false, error: `requirement ${i} is not an object` };
    }
    if (typeof r.text !== "string") {
      return { ok: false, error: `requirement ${i} text must be a string` };
    }
    const text = r.text.trim();
    if (text === "") {
      return { ok: false, error: `requirement ${i} text is empty` };
    }
    if (text.length > MAX_TEXT_LEN) {
      return { ok: false, error: `requirement ${i} text exceeds ${MAX_TEXT_LEN} chars` };
    }
    if (
      typeof r.kind !== "string" ||
      !(REQUIREMENT_KINDS as readonly string[]).includes(r.kind)
    ) {
      return { ok: false, error: `requirement ${i} has an invalid kind` };
    }
    requirements.push({ text, kind: r.kind as RequirementKind });
  }

  return {
    ok: true,
    value: { company: company.value, title: title.value, requirements },
  };
}
