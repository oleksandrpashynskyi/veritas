// The coverage contract + fail-closed validators. PURE — no SDK, no `server-only` — so it is
// unit-testable (coverage-schema.test.ts) and reusable on both sides of the boundary: it runs on the
// matcher's structured output in matching.ts AND again on the client-submitted preview payload in the
// saveCoverage path (persistCoverage). "Trust the parse, not the prose" (AGENTS.md / M3 plan).
//
// Two layers, deliberately split:
//   validateCoverage   — STRUCTURAL: shape, status enum, UUID-shaped ids, evidence-consistency, caps.
//                        Knows nothing about which ids are real. Pure over an UNKNOWN value.
//   reconcileCitations — PROVENANCE: every cited fact_id is one the user OWNS and every requirement_id
//                        belongs to THIS job. Pure over already-validated entries + the real id sets
//                        (which the caller builds from the per-user/RLS client — see persistCoverage).
// Realness/ownership is therefore proven against the DB by persistCoverage + verify-m4, not here.

export const COVERAGE_STATUSES = ["met", "partial", "unmet"] as const;
export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];

export type CoverageEntry = {
  requirement_id: string;
  status: CoverageStatus;
  fact_ids: string[];
};

export type Coverage = { coverage: CoverageEntry[] };

export type CoverageResult =
  | { ok: true; value: Coverage }
  | { ok: false; error: string };

export type ReconcileResult =
  | { ok: true; rows: CoverageEntry[] }
  | { ok: false; error: string };

// Sanity caps — a single billed match over one job should never legitimately exceed these. The
// requirement list itself is capped at 200 at extraction time, so coverage entries are too; an
// entry citing more than a few dozen facts signals a runaway response. Exceeding => fail closed.
const MAX_ENTRIES = 200;
const MAX_FACT_IDS = 50;

// Postgres gen_random_uuid() output. Anything else (a placeholder like "req-1", an index, a name) is
// not a real id and is rejected structurally — before it can reach the DB or the ownership check.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// JSON Schema for Anthropic Structured Outputs. Guarantees the SHAPE (object with a `coverage` array
// of {requirement_id, status, fact_ids}); the validator enforces what the schema can't express
// (UUID shape, met/partial<->evidence consistency, caps, no duplicate requirement) and fails closed
// if a refusal / max_tokens stop yields off-shape output.
export const COVERAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["coverage"],
  properties: {
    coverage: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["requirement_id", "status", "fact_ids"],
        properties: {
          requirement_id: { type: "string" },
          status: { type: "string", enum: [...COVERAGE_STATUSES] },
          fact_ids: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStatus(v: unknown): v is CoverageStatus {
  return typeof v === "string" && (COVERAGE_STATUSES as readonly string[]).includes(v);
}

// Validate an UNKNOWN value (parsed matcher JSON, or a client-submitted preview payload) into a clean
// Coverage. Rejects the WHOLE thing on any malformed/off-shape/self-inconsistent part — never returns
// partial structure. Normalizes on success (de-dupes fact_ids, drops unexpected entry properties).
export function validateCoverage(raw: unknown): CoverageResult {
  if (!isPlainObject(raw)) {
    return { ok: false, error: "coverage payload is not an object" };
  }
  const list = raw.coverage;
  if (!Array.isArray(list)) {
    return { ok: false, error: "coverage must be an array" };
  }
  if (list.length > MAX_ENTRIES) {
    return { ok: false, error: `too many coverage entries (> ${MAX_ENTRIES})` };
  }

  const coverage: CoverageEntry[] = [];
  const seenReq = new Set<string>();

  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!isPlainObject(e)) {
      return { ok: false, error: `coverage ${i} is not an object` };
    }
    if (typeof e.requirement_id !== "string" || !UUID_RE.test(e.requirement_id)) {
      return { ok: false, error: `coverage ${i} requirement_id is not a uuid` };
    }
    if (seenReq.has(e.requirement_id)) {
      return { ok: false, error: `coverage ${i} duplicates requirement ${e.requirement_id}` };
    }
    if (!isStatus(e.status)) {
      return { ok: false, error: `coverage ${i} has an invalid status` };
    }
    if (!Array.isArray(e.fact_ids)) {
      return { ok: false, error: `coverage ${i} fact_ids must be an array` };
    }
    if (e.fact_ids.length > MAX_FACT_IDS) {
      return { ok: false, error: `coverage ${i} cites too many facts (> ${MAX_FACT_IDS})` };
    }

    const factIds: string[] = [];
    const seenFact = new Set<string>();
    for (const fid of e.fact_ids) {
      if (typeof fid !== "string" || !UUID_RE.test(fid)) {
        return { ok: false, error: `coverage ${i} fact_ids contains a non-uuid value` };
      }
      if (!seenFact.has(fid)) {
        seenFact.add(fid);
        factIds.push(fid);
      }
    }

    // Evidence-consistency — the structural guard against an inflated "met" with no proof. Mirrors
    // the DB CHECK coverage_evidence_consistent so an over-claim is rejected here, before the DB.
    if (e.status === "unmet" && factIds.length !== 0) {
      return { ok: false, error: `coverage ${i} is unmet but cites evidence` };
    }
    if ((e.status === "met" || e.status === "partial") && factIds.length === 0) {
      return { ok: false, error: `coverage ${i} is ${e.status} but cites no evidence` };
    }

    seenReq.add(e.requirement_id);
    coverage.push({ requirement_id: e.requirement_id, status: e.status, fact_ids: factIds });
  }

  return { ok: true, value: { coverage } };
}

// The provenance reconciler. `ownedFactIds` and `jobRequirementIds` are the user's REAL data, fetched
// by the caller through the per-user (RLS) client — so an id the user cannot see is simply absent.
// Fails closed if the matcher cited a fact the user does not own or a requirement outside this job.
// On success returns one row PER job requirement: the matcher's assessment where given, `unmet` (no
// evidence) for any requirement it omitted — so a gap is recorded honestly, never silently dropped.
export function reconcileCitations(args: {
  entries: CoverageEntry[];
  ownedFactIds: Set<string>;
  jobRequirementIds: Set<string>;
}): ReconcileResult {
  const { entries, ownedFactIds, jobRequirementIds } = args;
  const byReq = new Map<string, CoverageEntry>();

  for (const e of entries) {
    if (!jobRequirementIds.has(e.requirement_id)) {
      return { ok: false, error: `requirement ${e.requirement_id} is not part of this job` };
    }
    for (const fid of e.fact_ids) {
      if (!ownedFactIds.has(fid)) {
        return { ok: false, error: `fact ${fid} is not an owned, real fact` };
      }
    }
    byReq.set(e.requirement_id, e);
  }

  const rows: CoverageEntry[] = [];
  for (const reqId of jobRequirementIds) {
    rows.push(byReq.get(reqId) ?? { requirement_id: reqId, status: "unmet", fact_ids: [] });
  }
  return { ok: true, rows };
}
