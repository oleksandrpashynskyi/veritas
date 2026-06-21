// Requirements x facts -> coverage. The Anthropic key + SDK live solely in ./client (runStructured);
// this module owns only the matching PROMPT + schema + fail-closed validation. It is server-only by
// transitivity (./client imports "server-only"); shared code must import the pure
// validator/vocabulary from "@/lib/llm/coverage-schema" instead, never this file.
import { runStructured } from "./client";
import {
  COVERAGE_SCHEMA,
  validateCoverage,
  type CoverageResult,
} from "./coverage-schema";

// Decision locked (Alex): Haiku to start — conservative-classification instruction + the user's
// review are the backstops. If classification disappoints, this is the place to move to Sonnet.
const MODEL = "claude-haiku-4-5";
const MAX_TOKENS = 4096;

// The only inputs the matcher needs: the requirement/fact TEXT and stable ids to cite. `verified` is
// deliberately NOT passed — verification is a display/trust concern surfaced in the UI (Q1), not a
// matching signal, and feeding it could bias the judgment. ids are echoed back as citations.
export type MatchRequirement = { id: string; text: string; kind: string };
export type MatchFact = {
  id: string;
  type: string;
  content: string;
  employer: string | null;
  role: string | null;
};

// The product exists to kill inflated claims, so the prompt's whole job is to make the model
// UNDER-claim. "met" demands direct, unambiguous support; anything requiring inference is at most
// "partial"; absence of evidence is "unmet". The conservative bias + the user's review are the
// backstops behind the structural evidence-consistency check in validateCoverage.
const SYSTEM_PROMPT = `You assess how well a candidate's career FACTS satisfy each REQUIREMENT of a job.

You are given JSON with:
- requirements: each has an "id", a "text", and a "kind".
- facts: each has an "id", a "type", and "content" (plus optional employer/role).

For EACH requirement, choose a status and cite the supporting fact ids:
- "met": the cited facts DIRECTLY and UNAMBIGUOUSLY satisfy the requirement.
- "partial": there is relevant but incomplete, indirect, or ambiguous evidence.
- "unmet": no fact supports the requirement.

Honesty rules — follow them strictly; this product exists to kill inflated claims:
- Bias toward UNDER-claiming. When torn between two statuses, choose the LOWER one
  (met -> partial -> unmet). "met" requires direct, unambiguous support; if you must reason or
  assume to connect a fact to a requirement, it is at most "partial".
- Do NOT infer a skill, tool, or experience that a fact does not explicitly state.
- Cite ONLY "id" values that appear in the provided facts, and classify ONLY requirement "id"
  values that appear in the provided requirements. NEVER invent an id.
- Evidence rule: "met" and "partial" MUST cite at least one fact id; "unmet" MUST cite none.
- Return EXACTLY ONE entry per requirement.`;

// One billed match: requirements + facts -> Haiku (Structured Outputs) -> parse -> fail-closed
// validate (status enum, UUID-shaped ids, evidence-consistency, caps). Returns the SAME shape as the
// pure validator; every failure mode is a closed `{ ok: false }`. Ownership of the cited ids is NOT
// checked here — that is persistCoverage's job, against the user's real facts. Inputs are personal
// data and are never logged.
export async function matchCoverage(
  requirements: MatchRequirement[],
  facts: MatchFact[],
): Promise<CoverageResult> {
  const user = JSON.stringify({ requirements, facts });

  const res = await runStructured({
    model: MODEL,
    maxTokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    user,
    schema: COVERAGE_SCHEMA,
  });
  if (!res.ok) return res;

  return validateCoverage(res.parsed);
}
